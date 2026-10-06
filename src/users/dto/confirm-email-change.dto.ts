import { Transform, TransformFnParams } from 'class-transformer';
import { IsUUID, Matches } from 'class-validator';

export class ConfirmEmailChangeDto {
  @Transform(({ value }: TransformFnParams) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsUUID('4')
  challengeId!: string;

  @Matches(/^\d{6}$/)
  code!: string;
}
