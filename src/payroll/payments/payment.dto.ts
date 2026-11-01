import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MOCK_SCENARIOS } from './mock-payroll.provider';
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class PreparePayrollPaymentDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(150) payerName!: string;
  @IsEmail() @MaxLength(254) payerEmail!: string;
  @Matches(/^\+?\d{10,15}$/) payerPhone!: string;
}
export class EmptyPaymentDto {}
export class MockPaymentEventDto {
  @IsIn(MOCK_SCENARIOS) scenario!: (typeof MOCK_SCENARIOS)[number];
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,80}$/) eventId!: string;
}
