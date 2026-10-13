import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import {
  AnalyticsQueryDto,
  AssignmentDto,
  AssigneeQueryDto,
  DashboardTaskQueryDto,
  CommentDto,
  PageDto,
  ReasonDto,
  ReviewDto,
  ReviewerQueryDto,
  RevisionDto,
  SubmissionDto,
  TaskCreateDto,
  TaskPatchDto,
  TaskQueryDto,
  UploadIntentDto,
} from './task.dto';
import { TaskService } from './task.service';
import { TaskReadService } from './task-read.service';
import { TaskAnalyticsService } from './task-analytics.service';
import { TaskImagesService } from './task-images.service';
import { TaskErrorFilter } from './task-error.filter';
@Controller('businesses/:businessId')
@UseGuards(AccessTokenGuard)
@UseFilters(TaskErrorFilter)
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly read: TaskReadService,
    private readonly analytics: TaskAnalyticsService,
    private readonly images: TaskImagesService,
  ) {}
  @Get('tasks') @Header('Cache-Control', 'no-store') list(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: TaskQueryDto,
  ) {
    return this.read.list(r.auth.userId, b, q);
  }
  @Post('tasks') create(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() dto: TaskCreateDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tasks.create(r.auth.userId, b, dto, key);
  }
  @Get('task-assignees') @Header('Cache-Control', 'no-store') assignees(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: AssigneeQueryDto,
  ) {
    return this.read.assignees(r.auth.userId, b, q);
  }
  @Get('task-reviewers') @Header('Cache-Control', 'no-store') reviewers(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: ReviewerQueryDto,
  ) {
    return this.read.reviewers(r.auth.userId, b, q);
  }
  @Get('task-analytics') @Header('Cache-Control', 'no-store') report(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: AnalyticsQueryDto,
  ) {
    return this.analytics.report(r.auth.userId, b, q);
  }
  @Get('tasks/:taskId') @Header('Cache-Control', 'no-store') detail(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
  ) {
    return this.read.detail(r.auth.userId, b, t);
  }
  @Patch('tasks/:taskId') patch(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: TaskPatchDto,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'patch', dto);
  }
  @Post('tasks/:taskId/assignments') @HttpCode(200) assign(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: AssignmentDto,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'assign', dto);
  }
  @Post('tasks/:taskId/start') @HttpCode(200) start(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: RevisionDto,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'start', dto);
  }
  @Post('tasks/:taskId/submissions') @HttpCode(200) submit(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: SubmissionDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'submit', dto, key);
  }
  @Post('tasks/:taskId/attempts/:attemptId/review') @HttpCode(200) review(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Param('attemptId') attempt: string,
    @Body() dto: ReviewDto,
  ) {
    return this.tasks.mutate(
      r.auth.userId,
      b,
      t,
      'review',
      dto,
      undefined,
      attempt,
    );
  }
  @Post('tasks/:taskId/reopen') @HttpCode(200) reopen(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: ReasonDto,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'reopen', dto);
  }
  @Post('tasks/:taskId/cancel') @HttpCode(200) cancel(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: ReasonDto,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'cancel', dto);
  }
  @Get('tasks/:taskId/attempts') @Header('Cache-Control', 'no-store') attempts(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Query() q: PageDto,
  ) {
    return this.read.collection(r.auth.userId, b, t, 'attempts', q);
  }
  @Get('tasks/:taskId/history') @Header('Cache-Control', 'no-store') history(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Query() q: PageDto,
  ) {
    return this.read.collection(r.auth.userId, b, t, 'history', q);
  }
  @Get('tasks/:taskId/assignments')
  @Header('Cache-Control', 'no-store')
  assignments(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Query() q: PageDto,
  ) {
    return this.read.collection(r.auth.userId, b, t, 'assignments', q);
  }
  @Get('tasks/:taskId/comments') @Header('Cache-Control', 'no-store') comments(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Query() q: PageDto,
  ) {
    return this.read.collection(r.auth.userId, b, t, 'comments', q);
  }
  @Post('tasks/:taskId/comments') comment(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: CommentDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tasks.mutate(r.auth.userId, b, t, 'comment', dto, key);
  }
  @Post('tasks/:taskId/images/upload-intents') intent(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Body() dto: UploadIntentDto,
  ) {
    return this.images.intent(r.auth.userId, b, t, dto);
  }
  @Post('tasks/:taskId/images/:imageId/finalize') @HttpCode(200) finalize(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Param('imageId') image: string,
  ) {
    return this.images.finalize(r.auth.userId, b, t, image);
  }
  @Delete('tasks/:taskId/images/:imageId') remove(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Param('imageId') image: string,
  ) {
    return this.images.remove(r.auth.userId, b, t, image);
  }
  @Get('tasks/:taskId/images/:imageId/content') async content(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('taskId') t: string,
    @Param('imageId') image: string,
    @Query('token') token: string,
    @Res() response: Response,
  ) {
    const result = await this.images.content(r.auth.userId, b, t, image, token);
    response
      .set({
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(result.bytes);
  }
}
@Controller('dashboard')
@UseGuards(AccessTokenGuard)
@UseFilters(TaskErrorFilter)
export class DashboardTaskController {
  constructor(private readonly read: TaskReadService) {}
  @Get('tasks') @Header('Cache-Control', 'no-store') tasks(
    @Req() r: AuthenticatedRequest,
    @Query() q: DashboardTaskQueryDto,
  ) {
    return this.read.list(r.auth.userId, undefined, q, true);
  }
}
