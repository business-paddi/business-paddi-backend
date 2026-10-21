import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import type { AuthenticatedRequest } from '../auth-guard/authenticated-request';
import { BusinessCacheInterceptor } from '../business/business-cache.interceptor';
import type { RequestWithContext } from '../common/middleware/request-context.middleware';
import { catalog } from './plan-catalog';
import {
  EmptyReferralDto,
  PlanSelectionDto,
  ReferralPageDto,
} from './referrals.dto';
import { ReferralsService } from './referrals.service';
import { ReferralsErrorFilter } from './referrals-error.filter';
@Controller('plans')
export class PlansController {
  @Get() @Header('Cache-Control', 'public, max-age=300') get() {
    return catalog();
  }
}
@Controller('account')
@UseGuards(AccessTokenGuard)
@UseFilters(ReferralsErrorFilter)
@UseInterceptors(BusinessCacheInterceptor)
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}
  @Get('referrals') summary(@Req() r: AuthenticatedRequest) {
    return this.referrals.summary(r.auth.userId);
  }
  @Post('referrals/code') @HttpCode(200) code(
    @Req() r: AuthenticatedRequest & RequestWithContext,
    @Body() body: EmptyReferralDto,
  ) {
    if (Object.keys(body ?? {}).length)
      throw new BadRequestException(
        'Referral code creation accepts no request fields.',
      );
    return this.referrals.createCode(r.auth.userId, r.requestId);
  }
  @Get('referrals/earnings') earnings(
    @Req() r: AuthenticatedRequest,
    @Query() query: ReferralPageDto,
  ) {
    return this.referrals.earnings(r.auth.userId, query.cursor);
  }
  @Post('plan-selection') @HttpCode(200) select(
    @Req() r: AuthenticatedRequest & RequestWithContext,
    @Body() input: PlanSelectionDto,
  ) {
    return this.referrals.selectPlan(r.auth.userId, input, r.requestId);
  }
}
