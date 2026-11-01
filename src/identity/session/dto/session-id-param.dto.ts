import { IsString, MaxLength, MinLength } from 'class-validator';

export class SessionIdParamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sessionId!: string;
}
