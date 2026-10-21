import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { PayrollService } from './payroll.service';
import { PayrollReadService } from './payroll-read.service';
import {
  PayrollCreateDto,
  PayrollPatchDto,
  PayrollRecipientPatchDto,
  PayrollRefreshDto,
  PayrollSubmitDto,
  PayrollReviewDto,
  PayrollCancelDto,
  PayrollListDto,
  PayrollCandidateDto,
  PayrollRecipientsDto,
} from './payroll.dto';
import { PayrollErrorFilter } from './payroll-error.filter';
@Controller('businesses/:businessId/payroll')
@UseGuards(AccessTokenGuard)
@UseFilters(PayrollErrorFilter)
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly read: PayrollReadService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Get('batches')
  list(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: PayrollListDto,
  ) {
    return this.read.list(r.auth.userId, b, q);
  }
  @Header('Cache-Control', 'no-store')
  @Get('candidates')
  candidates(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Query() q: PayrollCandidateDto,
  ) {
    return this.read.candidates(r.auth.userId, b, q);
  }
  @Header('Cache-Control', 'no-store')
  @Get('batches/:batchId')
  detail(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
  ) {
    return this.read.detail(r.auth.userId, b, id);
  }
  @Header('Cache-Control', 'no-store')
  @Get('batches/:batchId/recipients')
  recipients(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Query() q: PayrollRecipientsDto,
  ) {
    return this.read.recipients(r.auth.userId, b, id, q);
  }
  @Header('Cache-Control', 'no-store')
  @Post('batches')
  create(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Body() body: PayrollCreateDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.create(r.auth.userId, b, body, key);
  }
  @Header('Cache-Control', 'no-store')
  @Patch('batches/:batchId')
  patch(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Body() body: PayrollPatchDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(r.auth.userId, b, id, 'patch', body, key);
  }
  @Header('Cache-Control', 'no-store')
  @Patch('batches/:batchId/recipients/:recipientId')
  recipient(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Param('recipientId') recipientId: string,
    @Body() body: PayrollRecipientPatchDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(
      r.auth.userId,
      b,
      id,
      'recipient',
      body,
      key,
      recipientId,
    );
  }
  @Header('Cache-Control', 'no-store')
  @Post('batches/:batchId/refresh')
  @HttpCode(200)
  refresh(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Body() body: PayrollRefreshDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(r.auth.userId, b, id, 'refresh', body, key);
  }
  @Header('Cache-Control', 'no-store')
  @Post('batches/:batchId/submit')
  @HttpCode(200)
  submit(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Body() body: PayrollSubmitDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(r.auth.userId, b, id, 'submit', body, key);
  }
  @Header('Cache-Control', 'no-store')
  @Post('batches/:batchId/review')
  @HttpCode(200)
  review(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Body() body: PayrollReviewDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(r.auth.userId, b, id, 'review', body, key);
  }
  @Header('Cache-Control', 'no-store')
  @Post('batches/:batchId/cancel')
  @HttpCode(200)
  cancel(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') id: string,
    @Body() body: PayrollCancelDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payroll.mutate(r.auth.userId, b, id, 'cancel', body, key);
  }
}
