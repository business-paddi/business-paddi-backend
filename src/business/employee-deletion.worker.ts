import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { EmployeeLifecycleService } from './employee-lifecycle.service';

@Injectable()
export class EmployeeDeletionWorker
  implements OnModuleInit, OnApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(EmployeeDeletionWorker.name);
  constructor(private readonly lifecycle: EmployeeLifecycleService) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.reconcile(), 60000);
    this.timer.unref();
    void this.reconcile();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      await this.lifecycle.processDue();
    } catch {
      this.logger.warn('Scheduled employee deletion failed; will retry.');
    } finally {
      this.running = false;
    }
  }
}
