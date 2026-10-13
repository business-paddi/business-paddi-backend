import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export const CONTACT_PLANS = [
  'starter',
  'growth',
  'standard',
  'efficient',
  'unsure',
];
export const CONTACT_FOCUS = [
  'Payroll approvals',
  'Inventory logs',
  'Payment security',
  'Batch and expiry tracking',
];
export class ContactDto {
  @IsIn(['contact', 'demo']) kind!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  businessName!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) locations?: string;
  @IsOptional() @IsIn(CONTACT_PLANS) planInterest?: string;
  @IsOptional() @IsIn(CONTACT_FOCUS) focus?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) message?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) website?: string;
}
