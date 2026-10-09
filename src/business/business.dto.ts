import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { NIGERIAN_STATES, DEFAULT_TYPE_KEYS } from './nigerian-states';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const email = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const optional = (object: unknown, value: unknown) => value !== undefined;

export class BusinessDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) industry?:
    string | null;
  @ValidateIf(optional) @IsIn(['NG']) country?: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  profileImage?: string | null;
}
export class UpdateBusinessDto {
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?:
    string | null;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) industry?:
    string | null;
  @ValidateIf(optional) @IsIn(['NG']) country?: string;
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  profileImage?: string | null;
}

class EmployeeOptionsDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) jobTitle?:
    string | null;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) managerEmployeeId?:
    string | null;
  @ValidateIf(optional)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  groupIds?: string[];
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  bankCode?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  bankName?: string | null;
  @IsOptional() @Transform(trim) @Matches(/^\d{10}$/) accountNumber?:
    string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  accountName?: string | null;
  @IsOptional() @Matches(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/) amount?:
    string | null;
  @ValidateIf(optional)
  @IsIn(['weekly', 'bi-weekly', 'monthly', 'one_time'])
  payFrequency?: string;
  @ValidateIf(optional) @IsIn(['NGN']) currency?: string;
  @ValidateIf(optional) @IsIn(['active', 'suspended', 'on_leave']) status?:
    'active' | 'suspended' | 'on_leave';
}
class EmployeeIdentityDto extends EmployeeOptionsDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) fullName!: string;
  @Transform(email) @IsEmail() @MaxLength(254) email!: string;
  @IsIn(NIGERIAN_STATES) state!: string;
}
export class EmployeeDto extends EmployeeIdentityDto {
  @IsString() @IsNotEmpty() @MaxLength(128) employeeTypeId!: string;
}
export class UpdateEmployeeDto extends EmployeeOptionsDto {
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName?: string;
  @ValidateIf(optional)
  @Transform(email)
  @IsEmail()
  @MaxLength(254)
  email?: string;
  @ValidateIf(optional) @IsIn(NIGERIAN_STATES) state?: string;
  @ValidateIf(optional)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  employeeTypeId?: string;
}
export class OnboardEmployeeDto extends EmployeeIdentityDto {
  @IsIn(DEFAULT_TYPE_KEYS) employeeTypeKey!: string;
  @ValidateIf(optional) @IsBoolean() connectToPlatform?: boolean;
}
export class OnboardDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => BusinessDto)
  business!: BusinessDto;
  @ValidateIf(optional)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OnboardEmployeeDto)
  employees?: OnboardEmployeeDto[];
}
export class EmployeeQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['active', 'suspended', 'on_leave', 'archived']) status?:
    'active' | 'suspended' | 'on_leave' | 'archived';
  @IsOptional() @IsString() @MaxLength(128) employeeTypeId?: string;
  @IsOptional() @IsIn(['fullName', 'email', 'createdAt']) sortBy:
    'fullName' | 'email' | 'createdAt' = 'createdAt';
  @IsOptional() @IsIn(['asc', 'desc']) sortOrder: 'asc' | 'desc' = 'desc';
}
export class GroupDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}
export class EmployeeTypeDto extends GroupDto {
  @Matches(/^[a-z][a-z0-9_]{0,63}$/) key!: string;
}
export class InviteDto {
  @Transform(email) @IsEmail() @MaxLength(254) email!: string;
  @ValidateIf(optional)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  employeeId?: string;
  @ValidateIf(optional)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  roleId?: string;
}
export class AcceptInviteDto {
  @Matches(/^[a-f0-9]{64}$/) token!: string;
}
export class TaxProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  taxIdentificationNumber?: string | null;
  @IsOptional() @IsIn(NIGERIAN_STATES) taxResidenceState?: string | null;
  @ValidateIf(optional) @Matches(/^[A-Z]{2}$/) taxResidenceCountry?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  employmentStartDate?: string | null;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  employmentEndDate?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  taxResidencyStatus?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  pensionFundAdministrator?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  pensionAccountNumber?: string | null;
  @IsOptional()
  @Matches(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/)
  pensionContributionRate?: string | null;
  @IsOptional()
  @Matches(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/)
  employerPensionContributionRate?: string | null;
  @IsOptional() @IsBoolean() nhfApplicable?: boolean | null;
  @IsOptional() @IsBoolean() nhisApplicable?: boolean | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  taxExemptionStatus?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  taxExemptionReason?: string | null;
}
