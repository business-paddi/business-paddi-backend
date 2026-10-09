import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import {
  BusinessController,
  BusinessInviteController,
} from './business.controller';
import { BusinessService } from './business.service';
import { EmployeeService } from './employee.service';
import { InviteService } from './invite.service';
import { BusinessAccessService } from './business-access.service';

@Module({
  imports: [EmailModule],
  controllers: [BusinessController, BusinessInviteController],
  providers: [
    BusinessService,
    EmployeeService,
    InviteService,
    BusinessAccessService,
  ],
})
export class BusinessModule {}
