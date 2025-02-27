import { Module } from '@nestjs/common';
import { TaskService } from './task.service';
import { TaskController } from './task.controller';
import {SequelizeModule} from "@nestjs/sequelize";
import {Task} from "./task.model";

@Module({
  providers: [TaskService],
  controllers: [TaskController],
  imports: [SequelizeModule.forFeature([Task])]
})
export class TaskModule {}
