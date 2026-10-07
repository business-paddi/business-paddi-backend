import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AUDIT_EVENTS } from '../audit/audit-event.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import type { RequestLocationContext } from '../location/location.service';
import type {
  OnboardingDraftShape,
  UpsertOnboardingDto,
} from './dto/upsert-onboarding.dto';
import {
  toOnboardingBusiness,
  toOnboardingStaff,
} from './dto/upsert-onboarding.dto';

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getDraft(userId: string): Promise<OnboardingDraftShape | null> {
    const draft = await this.prisma.onboardingDraft.findUnique({
      where: { userId },
    });
    if (!draft) return null;
    return {
      business: toOnboardingBusiness(draft.business),
      staff: toOnboardingStaff(draft.staff),
    };
  }

  async saveDraft(
    userId: string,
    input: UpsertOnboardingDto,
    context: RequestLocationContext,
  ): Promise<OnboardingDraftShape> {
    if (input.business === undefined && input.staff === undefined) {
      throw new BadRequestException(
        'At least one onboarding section is required',
      );
    }
    if (input.staff !== undefined) {
      const seen = new Set<string>();
      for (const member of input.staff) {
        if (seen.has(member.email)) {
          throw new BadRequestException('Staff email addresses must be unique');
        }
        seen.add(member.email);
      }
    }
    const current = await this.getDraft(userId);
    const shape: OnboardingDraftShape = {
      business:
        input.business !== undefined
          ? toOnboardingBusiness({ ...current?.business, ...input.business })
          : (current?.business ?? null),
      staff:
        input.staff !== undefined ? [...input.staff] : (current?.staff ?? []),
    };
    const businessJson = (shape.business ?? undefined) as
      Prisma.InputJsonValue | undefined;
    const staffJson = shape.staff as unknown as Prisma.InputJsonValue;
    await this.prisma.onboardingDraft.upsert({
      where: { userId },
      create: { userId, business: businessJson, staff: staffJson },
      update: { business: businessJson, staff: staffJson },
    });
    await this.audit.record({
      eventType: AUDIT_EVENTS.ACCOUNT_ONBOARDING_DRAFT_SAVED,
      category: 'account',
      outcome: 'success',
      userId,
      context,
    });
    return shape;
  }

  async completeOnboarding(userId: string, context: RequestLocationContext) {
    const draft = await this.getDraft(userId);
    if (!draft?.business?.name) {
      throw new BadRequestException(
        'Onboarding is incomplete: a business name is required',
      );
    }
    const result = await this.prisma.$transaction(async (transaction) => {
      const business = await transaction.business.create({
        data: {
          ownerId: userId,
          name: draft.business?.name ?? '',
          industry: draft.business?.industry ?? null,
          address: draft.business?.address ?? null,
        },
      });
      if (draft.staff.length > 0) {
        await transaction.staffInvite.createMany({
          data: draft.staff.map((member) => ({
            businessId: business.id,
            name: member.name,
            email: member.email,
            role: member.role,
          })),
          skipDuplicates: true,
        });
      }
      await transaction.onboardingDraft.deleteMany({ where: { userId } });
      await this.audit.record(
        {
          eventType: AUDIT_EVENTS.ACCOUNT_ONBOARDING_COMPLETED,
          category: 'account',
          outcome: 'success',
          userId,
          context,
          metadata: {
            businessId: business.id,
            inviteCount: draft.staff.length,
          },
        },
        transaction,
      );
      const invites = await transaction.staffInvite.findMany({
        where: { businessId: business.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          createdAt: true,
        },
      });
      return { business, invites };
    });
    return {
      message: 'Onboarding completed successfully',
      business: {
        id: result.business.id,
        name: result.business.name,
        industry: result.business.industry,
        address: result.business.address,
        createdAt: result.business.createdAt,
      },
      invites: result.invites,
    };
  }
}
