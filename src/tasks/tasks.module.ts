import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../business/business-access.service';
import { TaskAccessService } from './task-access.service';
import { TaskService } from './task.service';
import { TaskReadService } from './task-read.service';
import { TaskAnalyticsService } from './task-analytics.service';
import { TaskEventsService } from './task-events.service';
import { TaskOperationService } from './task-operation.service';
import { TaskImagesService } from './task-images.service';
import { DashboardTaskController, TaskController } from './task.controller';
import { TaskReminderService } from './task-reminder.service';
@Module({
  controllers: [TaskController, DashboardTaskController],
  providers: [
    BusinessAccessService,
    TaskAccessService,
    TaskService,
    TaskReadService,
    TaskAnalyticsService,
    TaskEventsService,
    TaskOperationService,
    TaskImagesService,
    TaskReminderService,
  ],
})
export class TasksModule {}
