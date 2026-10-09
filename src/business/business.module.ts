import { Module } from '@nestjs/common';
import {
  BusinessController,
  BusinessInviteController,
} from './business.controller';
import { BusinessService } from './business.service';
import { EmployeeService } from './employee.service';
import { InviteService } from './invite.service';
import { BusinessAccessService } from './business-access.service';
import { NotificationController } from './notification.controller';

@Module({
  controllers: [
    BusinessController,
    BusinessInviteController,
    NotificationController,
  ],
  providers: [
    BusinessService,
    EmployeeService,
    InviteService,
    BusinessAccessService,
  ],
})
export class BusinessModule {}
