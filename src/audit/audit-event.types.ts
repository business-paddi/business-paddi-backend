import type { RequestLocationContext } from '../location/location.service';

export const AUDIT_EVENTS = {
  ACCOUNT_REGISTERED: 'account.registered',
  ACCOUNT_PROFILE_UPDATED: 'account.profile.updated',
  ACCOUNT_PREFERENCES_UPDATED: 'account.preferences.updated',
  ACCOUNT_PASSWORD_CHANGED: 'account.password.changed',
  ACCOUNT_EMAIL_CHANGE_CODE_SENT: 'account.email_change.code_sent',
  ACCOUNT_EMAIL_CHANGED: 'account.email.changed',
  EMAIL_VERIFICATION_CODE_SENT: 'authentication.email_verification.code_sent',
  EMAIL_VERIFICATION_FAILED: 'authentication.email_verification.failed',
  EMAIL_VERIFIED: 'authentication.email_verification.succeeded',
  LOGIN_FAILED: 'authentication.login.failed',
  LOGIN_SUCCEEDED: 'authentication.login.succeeded',
  LOGIN_VERIFICATION_CODE_SENT: 'authentication.login_verification.code_sent',
  LOGIN_VERIFICATION_FAILED: 'authentication.login_verification.failed',
  LOGIN_VERIFICATION_REQUIRED: 'authentication.login_verification.required',
  SENSITIVE_VERIFICATION_CODE_SENT:
    'authentication.sensitive_verification.code_sent',
  GOOGLE_ACCOUNT_LINKED: 'account.auth_provider.google_linked',
  GOOGLE_ACCOUNT_LINK_FAILED: 'account.auth_provider.google_link_failed',
  PASSWORD_RESET_CODE_SENT: 'authentication.password_reset.code_sent',
  PASSWORD_RESET_COMPLETED: 'authentication.password_reset.completed',
  PASSWORD_RESET_FAILED: 'authentication.password_reset.failed',
  PASSWORD_RESET_REQUESTED: 'authentication.password_reset.requested',
  SESSION_REFRESH_REJECTED: 'session.refresh.rejected',
  SESSION_REFRESHED: 'session.refresh.succeeded',
  SESSION_REPLAY_DETECTED: 'security.refresh_token.replay_detected',
  SESSION_REVOKED: 'session.revoked',
  OAUTH_CLIENT_CREATED: 'oauth.client.created',
  OAUTH_CLIENT_SECRET_ROTATED: 'oauth.client.secret_rotated',
  OAUTH_CLIENT_DISABLED: 'oauth.client.disabled',
  OAUTH_AUTHORIZATION_APPROVED: 'oauth.authorization.approved',
  OAUTH_AUTHORIZATION_DENIED: 'oauth.authorization.denied',
  OAUTH_TOKEN_ISSUED: 'oauth.token.issued',
  OAUTH_TOKEN_REJECTED: 'oauth.token.rejected',
  OAUTH_GRANT_REVOKED: 'oauth.grant.revoked',
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
export type AuditCategory =
  'authentication' | 'account' | 'session' | 'security' | 'business';
export type AuditOutcome = 'success' | 'failure' | 'blocked';
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';
export type AuditValue = string | number | boolean | null;

export interface RecordAuditEventInput {
  eventType: AuditEventType;
  category: AuditCategory;
  outcome: AuditOutcome;
  severity?: AuditSeverity;
  userId?: string | null;
  email?: string | null;
  userSessionId?: string | null;
  authSessionId?: string | null;
  context?: RequestLocationContext | null;
  reason?: string | null;
  changes?: Record<string, AuditValue>;
  metadata?: Record<string, AuditValue>;
}
