import { IsIn } from 'class-validator';

export const SENSITIVE_ACTIONS = [
  'set-password',
  'change-email',
  'change-two-factor',
] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export class RequestSensitiveVerificationDto {
  @IsIn(SENSITIVE_ACTIONS)
  action!: SensitiveAction;
}
