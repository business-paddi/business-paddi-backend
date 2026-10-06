import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reauthToken?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
