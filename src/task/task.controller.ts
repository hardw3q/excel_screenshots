import {
    Controller,
    Post,
    Get,
    Param,
    UploadedFile,
    UseInterceptors,
    NotFoundException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiConsumes} from '@nestjs/swagger';
import { TaskService } from './task.service';
import { Task } from './task.model';

@ApiTags('Tasks')
@Controller('tasks')
export class TaskController {
    constructor(private readonly taskService: TaskService) {}

    @Post('upload')
    @ApiOperation({ summary: 'Upload XLSX file for processing' })
    @ApiConsumes('multipart/form-data') // Тип контента для POST запроса
    @UseInterceptors(FileInterceptor('file')) // Перехватчик для обработки файлов
    @ApiBody({
        description: 'Upload a template file',
        type: 'multipart/form-data', // Формат данных
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary', // Указываем формат для файла
                },

            },
        },
    })
    @ApiResponse({ status: 201, type: Task })
    async uploadFile(@UploadedFile() file: Express.Multer.File): Promise<Task> {
        return this.taskService.processFile(file);
    }

    @Get(':key')
    @ApiOperation({ summary: 'Get signed URL for download file' })
    @ApiParam({ name: 'key', type: String })
    @ApiResponse({ status: 200, type: String })
    @ApiResponse({ status: 404, description: 'File not found' })
    async getFile(@Param('key') key: string): Promise<{ url: string }> {
        const url = await this.taskService.getFileUrl(key);
        return { url };
    }

    @Get()
    @ApiOperation({ summary: 'Get all processing tasks' })
    @ApiResponse({ status: 200, type: [Task] })
    async getAllTasks(): Promise<Task[]> {
        return this.taskService.getAllTasks();
    }
}