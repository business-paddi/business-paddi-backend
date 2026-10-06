import { Transform, TransformFnParams } from 'class-transformer';
import { IsUUID } from 'class-validator';

export class ResendLoginVerificationDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsUUID('4')
  challengeId!: string;
}
