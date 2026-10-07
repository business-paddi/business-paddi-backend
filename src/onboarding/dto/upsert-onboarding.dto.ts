import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class OnboardingBusinessDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() || null : input;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string | null;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() || null : input;
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;
}

export class OnboardingStaffMemberDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  role!: string;
}

export class UpsertOnboardingDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OnboardingBusinessDto)
  business?: OnboardingBusinessDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OnboardingStaffMemberDto)
  staff?: OnboardingStaffMemberDto[];
}

export interface OnboardingBusiness {
  name?: string;
  industry?: string | null;
  address?: string | null;
}

export interface OnboardingStaffMember {
  name: string;
  email: string;
  role: string;
}

export interface OnboardingDraftShape {
  business: OnboardingBusiness | null;
  staff: OnboardingStaffMember[];
}

export function toOnboardingBusiness(
  value: unknown,
): OnboardingBusiness | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    industry: typeof record.industry === 'string' ? record.industry : null,
    address: typeof record.address === 'string' ? record.address : null,
  };
}

export function toOnboardingStaff(value: unknown): OnboardingStaffMember[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object',
    )
    .filter(
      (entry) =>
        typeof entry.name === 'string' &&
        typeof entry.email === 'string' &&
        typeof entry.role === 'string',
    )
    .map((entry) => ({
      name: entry.name as string,
      email: entry.email as string,
      role: entry.role as string,
    }));
}
