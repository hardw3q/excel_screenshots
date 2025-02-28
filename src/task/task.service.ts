// task.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as puppeteer from 'puppeteer';
import * as archiver from 'archiver';
import * as transliteration from 'transliteration';
import { v4 as uuidv4 } from 'uuid';
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectModel } from '@nestjs/sequelize';
import { Task } from './task.model';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Readable } from 'stream';

const mkdir = promisify(fs.mkdir);
const rm = promisify(fs.rm);

@Injectable()
export class TaskService {
    private s3Client: S3Client;

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

        try {
            const tempDir = path.join(__dirname, 'temp', task.id.toString());
            await mkdir(tempDir, { recursive: true });

            // Шаг 1: Чтение URL из Excel
            const urls = await this.readUrlsFromExcel(file.buffer);

            // Шаг 2: Создание скриншотов
            const screenshots = await this.createScreenshots(urls, tempDir);

            // Шаг 3: Создание ZIP-архива
            const zipPath = await this.createZip(screenshots, tempDir);
            console.log(zipPath);
            // Шаг 4: Загрузка в S3
            const s3Key = await this.uploadToS3(zipPath);

            // Обновление статуса задачи
            await task.update({
                status: 'completed',
                s3Key,
                processedAt: new Date(),
            });

            // Очистка временных файлов
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
            // console.log(row)
            if (rowNumber === 1) return; // Пропуск заголовка
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

    private async createScreenshots(urls: string[], outputDir: string): Promise<string[]> {
        const browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });

        const screenshots: string[] = [];

        try {
            for (const [index, url] of urls.entries()) {
                try {
                    const page = await browser.newPage();
                    await page.setViewport({ width: 1280, height: 720 });

                    // Настройка таймаута
                    await page.goto(url, {
                        waitUntil: 'networkidle2',
                        timeout: 30000
                    });

                    const screenshotPath = path.join(outputDir, `${index + 1}.png`);
                    await page.screenshot({
                        path: screenshotPath,
                        fullPage: true,
                        type: 'png',
                        // quality: 80,
                    });
                    console.log(screenshotPath);

                    screenshots.push(screenshotPath);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (err) {
                    console.error(`Error processing ${url}: ${err.message}`);
                }
            }
        } finally {
            await browser.close();
        }

        return screenshots;
    }

    private async createZip(files: string[], outputDir: string): Promise<string> {
        const zipPath = path.join(outputDir, 'screenshots.zip');
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', {
            zlib: { level: 9 }, // Максимальное сжатие
        });

        return new Promise((resolve, reject) => {
            output.on('close', () => resolve(zipPath));
            archive.on('warning', err => console.warn(err));
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
            const response = await this.s3Client.send(uploadCommand);
            console.log('S3 upload success:', response);
            return key;
        } catch (error) {
            console.error('S3 upload error:', {
                statusCode: error.$metadata?.httpStatusCode,
                message: error.message,
                rawResponse: error.$response?.body?.toString(),
                errorDetails: error,
            });
            throw new Error('Failed to upload to S3. Check server logs for details.');
        }
    }
}