import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListAuditEventsDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' && input ? Number(input) : input;
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;
}
