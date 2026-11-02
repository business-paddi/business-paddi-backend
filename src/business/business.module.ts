import {
  ImageUploadController,
  ImageUploadGuard,
} from './image-upload.controller';
import { AuthenticatedRateLimitService } from '../rate-limit/authenticated-rate-limit.service';
import { Module } from '@nestjs/common';
import {
  BusinessController,
  BusinessInviteController,
} from './business.controller';
import { BusinessService } from './business.service';
import { EmployeeService } from './employees/employee.service';
import { InviteService } from './invitations/invite.service';
import { BusinessAccessService } from './access/business-access.service';
import { NotificationController } from './notifications/notification.controller';
import { InviteEmailModule } from '../invite-email/invite-email.module';
import { InvitePermissionsService } from './invitations/invite-permissions.service';
import { InviteAcceptanceService } from './invitations/invite-acceptance.service';
import { MemberApprovalService } from './members/member-approval.service';
import { MemberApprovalController } from './members/member-approval.controller';
import { BusinessAuditController } from './audit/business-audit.controller';
import { BusinessAuditService } from './audit/business-audit.service';
import { GroupService } from './groups/group.service';
import { GroupController } from './groups/group.controller';
import { EmployeeLifecycleService } from './employees/employee-lifecycle.service';
import { EmployeeLifecycleController } from './employees/employee-lifecycle.controller';
import { EmployeeDeletionWorker } from './employees/employee-deletion.worker';

@Module({
  imports: [InviteEmailModule],
  controllers: [
    ImageUploadController,
    GroupController,
    EmployeeLifecycleController,
    BusinessController,
    BusinessInviteController,
    NotificationController,
    MemberApprovalController,
    BusinessAuditController,
  ],
  providers: [
    ImageUploadGuard,
    AuthenticatedRateLimitService,
    GroupService,
    EmployeeLifecycleService,
    EmployeeDeletionWorker,
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
