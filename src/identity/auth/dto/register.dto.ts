import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
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
  @MaxLength(40)
  name!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
