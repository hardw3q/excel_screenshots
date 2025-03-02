// task.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import * as archiver from 'archiver';
import * as transliteration from 'transliteration';
import { v4 as uuidv4 } from 'uuid';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectModel } from '@nestjs/sequelize';
import { Task } from './task.model';
import { URL } from 'url';
import * as process from 'process';

@Injectable()
export class TaskService {
    private s3Client: S3Client;
    private circuitBreakerState = {
        isOpen: false,
        lastFailure: 0,
        resetTimeout: 60000,
        failureCount: 0
    };

    constructor(
        @InjectModel(Task)
        private taskModel: typeof Task,
    ) {
        this.s3Client = new S3Client({
            region: 'ru-1',
            endpoint: 'https://s3.timeweb.cloud',
            forcePathStyle: true,
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY!,
                secretAccessKey: process.env.S3_SECRET_KEY!,
            },
            requestHandler: new NodeHttpHandler({
                connectionTimeout: 3000,
                requestTimeout: 10000,
            }),
            maxAttempts: 3,
        });
    }

    async processFile(file: Express.Multer.File): Promise<Task> {
        const task = await this.taskModel.create({
            status: 'processing',
            processedAt: new Date(),
        });
        console.log(task);
        try {
            const urls = await this.readUrlsFromExcel(file.buffer);
            await task.update({ urlsCount: urls.length });

            // Получаем S3-ключи для каждого скриншота
            const screenshotKeys = await this.createScreenshots(urls, task);

            // Создаём архив, извлекая изображения из S3
            const zipBuffer = await this.createZipFromS3(screenshotKeys);

            // Загружаем архив в S3
            const zipS3Key = await this.uploadBufferToS3(
                zipBuffer,
                `${uuidv4()}_${Date.now()}.zip`,
                'application/zip'
            );

            await task.update({
                status: 'completed',
                s3Key: zipS3Key,
                processedAt: new Date(),
            });

            return task;
        } catch (error) {
            await task.update({ status: 'failed' });
            throw error;
        }
    }

    async getFileUrl(key: string): Promise<string> {
        const task = await this.taskModel.findOne({ where: { s3Key: key } });
        if (!task) {
            throw new NotFoundException('File not found');
        }

        const command = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET!,
            Key: key,
        });

        return getSignedUrl(this.s3Client, command, { expiresIn: 3600 });
    }

    async getAllTasks(): Promise<Task[]> {
        return this.taskModel.findAll({
            order: [['processedAt', 'DESC']],
        });
    }

    private async readUrlsFromExcel(buffer: Buffer): Promise<string[]> {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const worksheet = workbook.worksheets[0];
        const urls: string[] = [];

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const urlCell = row.getCell(1);
            if (urlCell.type === ExcelJS.ValueType.String) {
                urls.push(urlCell.text.trim());
            }
        });

        return urls.filter(url => this.validateUrl(url));
    }

    private validateUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    private async createScreenshots(urls: string[], task: Task): Promise<string[]> {
        const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS) || 3;
        const INITIAL_TIMEOUT = Number(process.env.INITIAL_TIMEOUT) || 30000;
        const TIMEOUT_MULTIPLIER = Number(process.env.TIMEOUT_MULTIPLIER) || 2;
        const BASE_DELAY = Number(process.env.BASE_DELAY) || 2000;
        const JITTER = Number(process.env.JITTER) || 3000;

        let browser: puppeteer.Browser;
        const screenshotKeys: string[] = [];

        try {
            browser = await this.launchBrowser();
            const queue = this.createQueue(urls, INITIAL_TIMEOUT);

            while (queue.length > 0) {
                if (this.checkCircuitBreaker()) {
                    throw new Error('Service unavailable due to recent errors');
                }

                const item = queue.shift()!;
                let page: puppeteer.Page | null = null;

                try {
                    page = await browser.newPage();
                    await this.configurePage(page);

                    console.log(`Processing ${item.url} (attempt ${item.attempts + 1}/${MAX_ATTEMPTS})`);

                    const response = await this.navigatePage(page, item.url, item.timeout);
                    this.validateResponse(response);

                    // Захватываем скриншот и сразу загружаем его в S3
                    const s3Key = await this.takeScreenshot(page, item.url, screenshotKeys.length);
                    screenshotKeys.push(s3Key);

                    await this.taskModel.update(
                        { completed: screenshotKeys.length },
                        { where: { id: task.id } }
                    );

                    this.resetCircuitBreaker();
                    item.timeout = INITIAL_TIMEOUT;
                    await new Promise(resolve => setTimeout(resolve, BASE_DELAY + Math.random() * JITTER));
                } catch (error) {
                    await this.handleError(error, item, queue, MAX_ATTEMPTS, TIMEOUT_MULTIPLIER);
                    this.updateCircuitBreaker();

                    if (this.isFatalError(error)) {
                        browser = await this.restartBrowser(browser);
                    }
                } finally {
                    if (page && !page.isClosed()) {
                        await page.close();
                    }
                }
            }

            return screenshotKeys;
        } finally {
            //@ts-ignore
            if (browser) {
                await browser.close();
            }
        }
    }

    private async launchBrowser(): Promise<puppeteer.Browser> {
        return puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
        });
    }

    private createQueue(urls: string[], initialTimeout: number): Array<{ url: string; attempts: number; timeout: number }> {
        return urls.map(url => ({
            url,
            attempts: 0,
            timeout: initialTimeout
        }));
    }

    private async configurePage(page: puppeteer.Page): Promise<void> {
        await page.setViewport({ width: 1280, height: 720 });
        await page.setJavaScriptEnabled(true);
        // Устанавливаем пользовательский агент для имитации обычного браузера
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');
        // Разрешаем загрузку всех ресурсов
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            req.continue();
        });
    }

    private async navigatePage(page: puppeteer.Page, url: string, timeout: number): Promise<puppeteer.HTTPResponse | null> {
        return page.goto(url, {
            waitUntil: 'networkidle2',
            timeout,
        });
    }

    private validateResponse(response: puppeteer.HTTPResponse | null): void {
        if (response && response.status() >= 400) {
            throw new Error(`HTTP Error ${response.status()}`);
        }
    }

    /**
     * Захватывает скриншот, получает его buffer и сразу загружает в S3.
     * Возвращает S3-ключ изображения.
     */
    private async takeScreenshot(page: puppeteer.Page, url: string, index: number): Promise<string> {
        const filename = this.generateFilename(url, index + 1);
        const buffer = await page.screenshot({
            fullPage: true,
            type: 'png',
            captureBeyondViewport: true,
        });
        const s3Key = await this.uploadBufferToS3(Buffer.from(buffer), filename, 'image/png');
        console.log(`Screenshot uploaded to S3 with key: ${s3Key}`);
        return s3Key;
    }

    private generateFilename(url: string, index: number): string {
        try {
            const parsedUrl = new URL(url);
            const hostname = transliteration.slugify(parsedUrl.hostname);
            return `${index}_${hostname}_${Date.now()}.png`;
        } catch {
            return `${index}_${Date.now()}.png`;
        }
    }

    /**
     * Загружает Buffer в S3 по указанному ключу и возвращает его.
     */
    private async uploadBufferToS3(buffer: Buffer, key: string, contentType: string): Promise<string> {
        const uploadCommand = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET!,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        });

        try {
            await this.s3Client.send(uploadCommand);
            return key;
        } catch (error) {
            console.error('S3 upload error:', error);
            throw new Error('Failed to upload to S3');
        }
    }

    /**
     * Извлекает из S3 изображения по их ключам, добавляет их в архив (zip)
     * и возвращает архив в виде Buffer.
     */
    private async createZipFromS3(s3Keys: string[]): Promise<Buffer> {
        return new Promise(async (resolve, reject) => {
            const archive = archiver('zip', { zlib: { level: 9 } });
            const buffers: Buffer[] = [];
            archive.on('data', data => buffers.push(data));
            archive.on('error', reject);
            archive.on('end', () => {
                resolve(Buffer.concat(buffers));
            });

            // Для каждого S3-ключа получаем объект и добавляем его в архив
            for (const key of s3Keys) {
                try {
                    const command = new GetObjectCommand({
                        Bucket: process.env.S3_BUCKET!,
                        Key: key,
                    });
                    const response = await this.s3Client.send(command);
                    // response.Body – это поток (ReadableStream)
                    archive.append(response.Body, { name: key });
                } catch (error) {
                    console.error(`Error retrieving ${key} from S3:`, error);
                    return reject(error);
                }
            }

            archive.finalize();
        });
    }

    private async handleError(
        error: Error,
        item: { url: string; attempts: number; timeout: number },
        queue: Array<{ url: string; attempts: number; timeout: number }>,
        maxAttempts: number,
        timeoutMultiplier: number
    ): Promise<void> {
        console.error(`Attempt ${item.attempts + 1} failed for ${item.url}: ${error.message}`);

        if (item.attempts < maxAttempts - 1) {
            item.attempts++;
            item.timeout *= timeoutMultiplier;
            queue.push(item);
            console.log(`Requeued: ${item.url} (new timeout: ${item.timeout}ms)`);
        } else {
            console.error(`Max attempts reached for: ${item.url}`);
        }
    }

    private isFatalError(error: Error): boolean {
        const fatalMessages = [
            'Protocol error',
            'Session closed',
            'Navigation failed',
            'Target closed'
        ];
        return fatalMessages.some(msg => error.message.includes(msg));
    }

    private async restartBrowser(oldBrowser: puppeteer.Browser): Promise<puppeteer.Browser> {
        console.log('Restarting browser...');
        await oldBrowser.close();
        return this.launchBrowser();
    }

    private checkCircuitBreaker(): boolean {
        if (this.circuitBreakerState.isOpen) {
            if (Date.now() - this.circuitBreakerState.lastFailure > this.circuitBreakerState.resetTimeout) {
                this.circuitBreakerState.isOpen = false;
                this.circuitBreakerState.failureCount = 0;
                return false;
            }
            return true;
        }
        return false;
    }

    private resetCircuitBreaker(): void {
        this.circuitBreakerState.failureCount = 0;
    }

    private updateCircuitBreaker(): void {
        this.circuitBreakerState.failureCount++;
        if (this.circuitBreakerState.failureCount > 5) {
            this.circuitBreakerState.isOpen = true;
            this.circuitBreakerState.lastFailure = Date.now();
            console.error('Circuit breaker triggered!');
        }
    }

    async getTask(id: number) {
        return this.taskModel.findByPk(id);
    }
}
