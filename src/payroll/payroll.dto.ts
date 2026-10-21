import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
const provided = (_: unknown, v: unknown) => v !== undefined;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export const FREQUENCIES = ['weekly', 'bi-weekly', 'monthly', 'one_time'];
export const STATUSES = [
  'draft',
  'submitted',
  'changes_requested',
  'approved',
  'cancelled',
];
export const MONEY = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export class PayrollInputsDto {
  @Equals('resident_employee') employmentCategory!: string;
  @Equals('ng-2026-monthly-v1') policy!: string;
  @Equals(2026) taxYear!: number;
  @Equals(true) regularMonthlyCashOnly!: boolean;
  @Equals(true) soleEmployment!: boolean;
  @Equals(true) claimsReviewed!: boolean;
  @IsBoolean() pensionApplicable!: boolean;
  @IsString() @Matches(MONEY) pensionableMonthlyAmount!: string;
  @IsString() @Matches(MONEY) basicMonthlyAmount!: string;
  @IsString() @Matches(MONEY) housingMonthlyAmount!: string;
  @IsString() @Matches(MONEY) transportMonthlyAmount!: string;
  @IsString() @Matches(MONEY) annualRentPaid!: string;
  @IsString() @Matches(MONEY) annualMortgageInterest!: string;
  @IsString() @Matches(MONEY) annualLifeInsurancePremium!: string;
  @IsString() @Matches(MONEY) nhisEmployeeMonthlyAmount!: string;
  @IsString() @Matches(MONEY) nhisEmployerMonthlyAmount!: string;
  @IsString() @MaxLength(500) evidenceReference!: string;
  @IsString() @IsNotEmpty() @MaxLength(500) pensionApplicabilityReason!: string;
}
export class PayrollCreateDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @Matches(DATE) periodStart!: string;
  @Matches(DATE) periodEnd!: string;
  @Matches(DATE) payDate!: string;
  @IsIn(FREQUENCIES) payFrequency!: string;
  @Equals('NGN') currency!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(250)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(128, { each: true })
  employeeIds!: string[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?:
    string | null;
}
export class PayrollRevisionDto {
  @IsInt() @Min(1) @Max(2147483646) expectedRevision!: number;
}
export class PayrollPatchDto extends PayrollRevisionDto {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;
  @ValidateIf(provided) @Matches(DATE) payDate?: string;
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @ValidateIf(provided)
  @IsArray()
  @ArrayMaxSize(250)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(128, { each: true })
  addEmployeeIds?: string[];
  @ValidateIf(provided)
  @IsArray()
  @ArrayMaxSize(250)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(128, { each: true })
  removeRecipientIds?: string[];
}
export class PayrollAdjustmentDto {
  @IsString() @IsNotEmpty() @MaxLength(100) clientId!: string;
  @IsIn(['allowance', 'deduction']) kind!: 'allowance' | 'deduction';
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) label!: string;
  @Matches(MONEY) amount!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(1000) reason!: string;
}
export class PayrollRecipientPatchDto extends PayrollRevisionDto {
  @ValidateIf(provided) @Matches(MONEY) baseAmount?: string;
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  baseOverrideReason?: string;
  @ValidateIf(provided)
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique((a: PayrollAdjustmentDto) => a.clientId)
  @ValidateNested({ each: true })
  @Type(() => PayrollAdjustmentDto)
  adjustments?: PayrollAdjustmentDto[];
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
export class PayrollRefreshDto extends PayrollRevisionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(250)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(128, { each: true })
  recipientIds!: string[];
}
export class PayrollSubmitDto extends PayrollRevisionDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) note?: string;
}
export class PayrollReviewDto extends PayrollSubmitDto {
  @IsIn(['approve', 'request_changes']) decision!: string;
}
export class PayrollCancelDto extends PayrollRevisionDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000) reason!: string;
}
export class PayrollPageDto {
  @IsOptional() @IsString() @MaxLength(8000) cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}
export class PayrollListDto extends PayrollPageDto {
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @Matches(DATE) periodFrom?: string;
  @IsOptional() @Matches(DATE) periodTo?: string;
}
export class PayrollCandidateDto extends PayrollPageDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsString() @MaxLength(128) employeeTypeId?: string;
  @IsOptional() @IsString() @MaxLength(128) groupId?: string;
  @IsOptional() @IsIn(FREQUENCIES) payFrequency?: string;
  @IsOptional() @Matches(DATE) periodStart?: string;
  @IsOptional() @Matches(DATE) periodEnd?: string;
}
export class PayrollRecipientsDto extends PayrollPageDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) q?: string;
  @IsOptional() @IsIn(['ready', 'blocked']) readiness?: string;
}
