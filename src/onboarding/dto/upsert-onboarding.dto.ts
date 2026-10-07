import { Transform, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const ONBOARDING_USE_CASES = [
  'manage_employees',
  'personal_records',
  'calculate_taxes',
  'pay_employees',
  'explore',
] as const;
export const ONBOARDING_USAGE = ['personal', 'employee', 'team'] as const;
export const REFERRAL_SOURCES = [
  'friend_or_colleague',
  'social_media',
  'search_engine',
  'advertisement',
  'event',
  'other',
] as const;

export class UpsertOnboardingDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(ONBOARDING_USE_CASES.length)
  @ArrayUnique()
  @IsIn(ONBOARDING_USE_CASES, { each: true })
  useCases?: (typeof ONBOARDING_USE_CASES)[number][];

  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @IsIn(ONBOARDING_USAGE)
  usage?: (typeof ONBOARDING_USAGE)[number] | null;

  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @IsIn(REFERRAL_SOURCES)
  referralSource?: (typeof REFERRAL_SOURCES)[number] | null;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() || null : input;
  })
  @ValidateIf(
    (_object: unknown, value: unknown) => value !== undefined && value !== null,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  referralDetails?: string | null;
}
