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
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { URL } from 'url';

const mkdir = promisify(fs.mkdir);
const rm = promisify(fs.rm);

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
            const tempDir = path.join(__dirname, 'temp', task.id.toString());
            await mkdir(tempDir, { recursive: true });

            const urls = await this.readUrlsFromExcel(file.buffer);
            await task.update({ urlsCount: urls.length });
            const screenshots = await this.createScreenshots(urls, tempDir, task);
            const zipPath = await this.createZip(screenshots, tempDir);
            const s3Key = await this.uploadToS3(zipPath);

            await task.update({
                status: 'completed',
                s3Key,
                processedAt: new Date(),
            });

            await rm(tempDir, { recursive: true });
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

    private async createScreenshots(urls: string[], outputDir: string, task: Task): Promise<string[]> {
        const MAX_ATTEMPTS = 3;
        const INITIAL_TIMEOUT = 30000;
        const TIMEOUT_MULTIPLIER = 2;
        const BASE_DELAY = 2000;
        const JITTER = 3000;

        let browser: puppeteer.Browser;
        const screenshots: string[] = [];

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

                    const screenshotPath = await this.takeScreenshot(page, outputDir, item.url, screenshots.length);
                    screenshots.push(screenshotPath);

                    await this.taskModel.update({
                        completed: screenshots.length,
                    }, { where: { id: task.id } });

                    this.resetCircuitBreaker();
                    item.timeout = INITIAL_TIMEOUT;
                    await this.randomDelay(BASE_DELAY, JITTER);

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

            return screenshots;
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
        // Устанавливаем пользовательский агент, чтобы имитировать обычный браузер
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36');

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

    private async takeScreenshot(
        page: puppeteer.Page,
        outputDir: string,
        url: string,
        index: number
    ): Promise<string> {
        const filename = this.generateFilename(url, index + 1);
        const screenshotPath = path.join(outputDir, filename);

        await page.screenshot({
            path: screenshotPath,
            fullPage: true,
            type: 'png',
            captureBeyondViewport: true,
        });

        console.log(`Screenshot saved: ${screenshotPath}`);
        return screenshotPath;
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

    private async randomDelay(base: number, jitter: number): Promise<void> {
        const delay = base + Math.random() * jitter;
        await new Promise(resolve => setTimeout(resolve, delay));
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

    private async createZip(files: string[], outputDir: string): Promise<string> {
        const zipPath = path.join(outputDir, 'screenshots.zip');
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', () => resolve(zipPath));
            archive.on('error', reject);
            archive.pipe(output);

            files.forEach(file => {
                archive.file(file, { name: path.basename(file) });
            });

            archive.finalize();
        });
    }

    private async uploadToS3(filePath: string): Promise<string> {
        const fileBuffer = await fs.promises.readFile(filePath);
        const key = `${uuidv4()}_${Date.now()}.zip`;

        const uploadCommand = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET!,
            Key: key,
            Body: fileBuffer,
            ContentType: 'application/zip',
        });

        try {
            await this.s3Client.send(uploadCommand);
            return key;
        } catch (error) {
            console.error('S3 upload error:', error);
            throw new Error('Failed to upload to S3');
        }
    }
}
