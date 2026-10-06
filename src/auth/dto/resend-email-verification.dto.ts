import { Transform, TransformFnParams } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class ResendEmailVerificationDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim().toLowerCase() : input;
  })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
