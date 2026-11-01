import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class NotificationQuery {
  @IsOptional() @IsString() @MaxLength(64) cursor?: string;
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 100;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  unreadOnly?: boolean;
}
