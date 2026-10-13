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
import { InviteEmailModule } from '../invite-email/invite-email.module';
import { InvitePermissionsService } from './invite-permissions.service';
import { InviteAcceptanceService } from './invite-acceptance.service';
import { MemberApprovalService } from './member-approval.service';
import { MemberApprovalController } from './member-approval.controller';
import { BusinessAuditController } from './business-audit.controller';
import { BusinessAuditService } from './business-audit.service';

@Module({
  imports: [InviteEmailModule],
  controllers: [
    BusinessController,
    BusinessInviteController,
    NotificationController,
    MemberApprovalController,
    BusinessAuditController,
  ],
  providers: [
    BusinessService,
    EmployeeService,
    InviteService,
    BusinessAccessService,
    InvitePermissionsService,
    InviteAcceptanceService,
    MemberApprovalService,
    BusinessAuditService,
  ],
})
export class BusinessModule {}
