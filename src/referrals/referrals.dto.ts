import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  BILLING_MODES,
  PLAN_KEYS,
  type BillingMode,
  type PlanKey,
} from './plan-catalog';
export class PlanSelectionDto {
  @IsIn(PLAN_KEYS) plan!: PlanKey;
  @IsIn(BILLING_MODES) mode!: BillingMode;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{6,128}$/)
  referralCode?: string;
}
export class ReferralPageDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(1000) cursor?: string;
}
export class EmptyReferralDto {}
