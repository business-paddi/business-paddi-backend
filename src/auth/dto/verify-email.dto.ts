import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{6}$/, {
    message: 'code must contain exactly 6 digits',
  })
  code!: string;
}
