import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePolicyClassesDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  names?: string[];
}

// Send the original text again with answers to any returned questions.
// The same payload can be submitted directly by a form, without text.
export class PolicyDraftDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text?: string;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  classId?: string;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  groupId?: string;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;
  @IsOptional()
  @IsString()
  @MaxLength(10)
  startsOn?: string;
  @IsOptional()
  @IsString()
  @MaxLength(10)
  endsOn?: string;
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(9999)
  year?: number;
}

export class AssignPolicyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  employeeId!: string;
}
