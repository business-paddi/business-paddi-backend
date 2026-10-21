import { Module } from '@nestjs/common';
import { BusinessAccessService } from '../business/business-access.service';
import { TaskOperationService } from '../tasks/task-operation.service';
import { PayrollController } from './payroll.controller';
import { PayrollAccessService } from './payroll-access.service';
import { PayrollSourceService } from './payroll-source.service';
import { PayrollEventsService } from './payroll-events.service';
import { PayrollReadService } from './payroll-read.service';
import { PayrollService } from './payroll.service';
@Module({
  controllers: [PayrollController],
  providers: [
    BusinessAccessService,
    TaskOperationService,
    PayrollAccessService,
    PayrollSourceService,
    PayrollEventsService,
    PayrollReadService,
    PayrollService,
  ],
})
export class PayrollModule {}
