import { IsUUID, Matches } from 'class-validator';

export class VerifySensitiveActionDto {
  @IsUUID('4')
  challengeId!: string;

  @Matches(/^\d{6}$/, { message: 'code must contain exactly 6 digits' })
  code!: string;
}
