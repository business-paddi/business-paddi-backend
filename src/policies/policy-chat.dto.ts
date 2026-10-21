import {
  IsArray,
  ArrayMaxSize,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CreatePolicyClassesDto } from './policy.dto';

export const POLICY_CHAT_ACTIONS = [
  'restart',
  'help',
  'create_class',
  'save_classes',
  'choose_class',
  'use_class',
  'describe_policy',
] as const;
export type PolicyChatAction = (typeof POLICY_CHAT_ACTIONS)[number];

export class PolicyChatReplyDto extends CreatePolicyClassesDto {
  @IsIn(POLICY_CHAT_ACTIONS)
  action!: PolicyChatAction;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  classId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(1000, { each: true })
  followUps?: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  answer?: string;
}
