import { BadRequestException, Injectable } from '@nestjs/common';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import type { RequestLocationContext } from '../location/location.service';
import type { UpsertOnboardingDto } from './dto/upsert-onboarding.dto';
import { toOnboardingPreferences } from './onboarding-preferences';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getDraft(userId: string) {
    const preferences = await this.prisma.userPreference.findUnique({
      where: { userId },
    });
    return toOnboardingPreferences(preferences);
  }

  async saveDraft(
    userId: string,
    input: UpsertOnboardingDto,
    context: RequestLocationContext,
  ) {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new BadRequestException(
        'At least one onboarding preference is required',
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      // Lock one user's preferences so concurrent referral edits have ordered audit history.
      await transaction.userPreference.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await transaction.$queryRaw`SELECT "userId" FROM "UserPreference" WHERE "userId" = ${userId} FOR UPDATE`;
      const current = await transaction.userPreference.findUniqueOrThrow({
        where: { userId },
      });
      const referralSource =
        input.referralSource !== undefined
          ? input.referralSource
          : current.onboardingReferralSource;
      const sourceChanged = referralSource !== current.onboardingReferralSource;
      const referralDetails =
        input.referralDetails !== undefined
          ? input.referralDetails
          : sourceChanged
            ? null
            : current.onboardingReferralDetails;
      if (referralDetails && referralSource !== 'other') {
        throw new BadRequestException(
          'Referral details are only allowed for the other referral source',
        );
      }
      const preferences = await transaction.userPreference.update({
        where: { userId },
        data: {
          onboardingUseCases: input.useCases,
          onboardingUsage: input.usage,
          onboardingReferralSource: referralSource,
          onboardingReferralDetails: referralDetails,
        },
      });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.ACCOUNT_ONBOARDING_PREFERENCES_UPDATED,
          category: 'account',
          outcome: 'success',
          userId,
          context,
        },
        transaction,
      );
      if (
        sourceChanged ||
        referralDetails !== current.onboardingReferralDetails
      ) {
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.ACCOUNT_REFERRAL_UPDATED,
            category: 'account',
            outcome: 'success',
            userId,
            context,
            metadata: {
              previousSource: current.onboardingReferralSource,
              source: referralSource,
              details: referralDetails,
            },
          },
          transaction,
        );
      }
      return toOnboardingPreferences(preferences);
    });
  }

  async completeOnboarding(userId: string, context: RequestLocationContext) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.userPreference.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      const completed = await transaction.userPreference.updateMany({
        where: { userId, onboardingCompletedAt: null },
        data: { onboardingCompletedAt: new Date() },
      });
      if (completed.count === 1) {
        await this.audit.record(
          {
            eventType: AUDIT_EVENTS.ACCOUNT_ONBOARDING_COMPLETED,
            category: 'account',
            outcome: 'success',
            userId,
            context,
          },
          transaction,
        );
      }
      const preferences = await transaction.userPreference.findUniqueOrThrow({
        where: { userId },
      });
      return {
        message: 'Onboarding completed successfully',
        onboarding: toOnboardingPreferences(preferences),
      };
    });
  }
}
