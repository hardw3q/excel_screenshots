import { Module } from '@nestjs/common';
import { TaskModule } from './task/task.module';
import {SequelizeModule} from "@nestjs/sequelize";
import { ConfigModule } from '@nestjs/config';
import {Task} from "./task/task.model";

@Module({
  imports: [TaskModule,
    ConfigModule.forRoot(),
    SequelizeModule.forRoot({
      dialect: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      models: [Task], // Добавьте ваши модели здесь
      autoLoadModels: true, // Автоматическая загрузка моделей
      synchronize: true, // Только для разработки!
      logging: console.log,
    }),
  ],
})
export class AppModule {}
