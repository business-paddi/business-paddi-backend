import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RemitaRuntime } from './remita-runtime';
import { PayrollPaymentService } from './payroll-payment.service';

@Injectable()
export class PayrollReconciler implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(PayrollReconciler.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: RemitaRuntime,
    private readonly payments: PayrollPaymentService,
  ) {}
  onModuleInit() {
    const env = this.runtime.environment();
    if (
      env.PAYROLL_PROVIDER !== 'remita' ||
      env.REMITA_RECONCILER_ENABLED === 'false'
    )
      return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.prisma.payrollPayment.findMany({
        where: {
          provider: 'remita_' + this.runtime.mode(),
          state: {
            in: [
              'CREATING',
              'INVOICE_UNKNOWN',
              'INVOICE_READY',
              'CANCEL_UNKNOWN',
            ],
          },
          OR: [
            { reconcileRequestedAt: { lte: new Date() } },
            {
              lastCheckedAt: null,
              updatedAt: { lt: new Date(Date.now() - 60000) },
            },
          ],
        },
        take: 10,
        orderBy: { updatedAt: 'asc' },
        select: { businessId: true, id: true },
      });
      for (const p of rows) await this.payments.reconcile(p.businessId, p.id);
    } catch {
      this.logger.warn(
        'Payroll reconciliation unavailable; no payment success inferred',
      );
    } finally {
      this.running = false;
    }
  }
}
