import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdatePreferencesDto {
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  desktopNotifications?: boolean;

  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  twoFactorEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  reauthToken?: string;
}
