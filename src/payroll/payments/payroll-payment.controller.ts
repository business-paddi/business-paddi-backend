import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../../identity/auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../../identity/auth-guard/authenticated-request';
import { BusinessCacheInterceptor } from '../../business/business-cache.interceptor';
import { PayrollErrorFilter } from '../payroll-error.filter';
import {
  EmptyPaymentDto,
  MockPaymentEventDto,
  PreparePayrollPaymentDto,
} from './payment.dto';
import { PayrollPaymentService } from './payroll-payment.service';

@Controller('businesses/:businessId/payroll')
@UseGuards(AccessTokenGuard)
@UseFilters(PayrollErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class PayrollPaymentController {
  constructor(private readonly payments: PayrollPaymentService) {}
  @Post('batches/:batchId/payment')
  prepare(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('batchId') batch: string,
    @Body() body: PreparePayrollPaymentDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.payments.prepare(r.auth.userId, b, batch, body, key);
  }
  @Get('payments/:paymentId')
  get(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
  ) {
    return this.payments.get(r.auth.userId, b, id);
  }
  @Post('payments/:paymentId/approve')
  @HttpCode(200)
  approve(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
    @Body() _body: EmptyPaymentDto,
  ) {
    // The global ValidationPipe validates this empty request DTO.
    void _body;
    return this.payments.approve(r.auth.userId, b, id);
  }
  @Post('payments/:paymentId/invoice')
  @HttpCode(200)
  invoice(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
    @Body() _body: EmptyPaymentDto,
  ) {
    // The global ValidationPipe validates this empty request DTO.
    void _body;
    return this.payments.invoice(r.auth.userId, b, id);
  }
  @Get('payments/:paymentId/payment-status')
  status(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
  ) {
    return this.payments.get(r.auth.userId, b, id);
  }
  @Post('payments/:paymentId/refresh-status')
  @HttpCode(200)
  refresh(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
    @Body() _body: EmptyPaymentDto,
  ) {
    // The global ValidationPipe validates this empty request DTO.
    void _body;
    return this.payments.refresh(r.auth.userId, b, id);
  }
  @Post('payments/:paymentId/cancel')
  @HttpCode(200)
  cancel(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
    @Body() _body: EmptyPaymentDto,
  ) {
    // The global ValidationPipe validates this empty request DTO.
    void _body;
    return this.payments.cancel(r.auth.userId, b, id);
  }
  @Post('payments/:paymentId/mock-event')
  @HttpCode(200)
  mock(
    @Req() r: AuthenticatedRequest,
    @Param('businessId') b: string,
    @Param('paymentId') id: string,
    @Body() body: MockPaymentEventDto,
  ) {
    return this.payments.mockEvent(r.auth.userId, b, id, body);
  }
}

@Controller('integrations/remita')
export class RemitaWebhookController {
  constructor(private readonly payments: PayrollPaymentService) {}
  @Post('webhook')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain')
  webhook(@Body() body: unknown, @Req() r: { ip?: string }) {
    return this.payments.webhook(body, r.ip ?? 'unknown');
  }
}
