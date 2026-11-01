import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class BankQueryDto {
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(80)
  country?: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Matches(/^(?:[A-Za-z]{3})?$/, {
    message: 'currency must be a three-letter currency code or empty',
  })
  currency?: string;
}
