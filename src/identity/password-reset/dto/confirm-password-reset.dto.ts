import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ConfirmPasswordResetDto {
  @IsUUID('4')
  challengeId!: string;

  @Matches(/^\d{6}$/, { message: 'code must contain exactly 6 digits' })
  code!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
