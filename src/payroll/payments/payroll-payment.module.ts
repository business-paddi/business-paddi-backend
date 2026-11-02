import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../../business/access/business-access.service';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { PayrollAccessService } from '../payroll-access.service';
import {
  PayrollPaymentController,
  RemitaWebhookController,
} from './payroll-payment.controller';
import { PayrollPaymentService } from './payroll-payment.service';
import { RemitaRuntime } from './remita-runtime';
import { PayrollReconciler } from './payroll-reconciler';
@Module({
  imports: [RateLimitModule],
  controllers: [PayrollPaymentController, RemitaWebhookController],
  providers: [
    BusinessAccessService,
    PayrollAccessService,
    PayrollPaymentService,
    RemitaRuntime,
    PayrollReconciler,
  ],
})
export class PayrollPaymentModule {}
