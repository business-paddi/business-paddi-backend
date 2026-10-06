import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestEmailChangeDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reauthToken?: string;
}
