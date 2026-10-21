import { Module } from '@nestjs/common';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { ReferralsController, PlansController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { ReferralVault } from './referral-vault';
import { ReferralCursor } from './referral-cursor';
import { ReferralAuditService } from './referral-audit.service';
import { ReferralSettlementService } from './referral-settlement.service';
@Module({
  imports: [RateLimitModule],
  controllers: [PlansController, ReferralsController],
  providers: [
    ReferralsService,
    ReferralVault,
    ReferralCursor,
    ReferralAuditService,
    ReferralSettlementService,
  ],
})
export class ReferralsModule {}
