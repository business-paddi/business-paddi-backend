export const INVITE_EMAIL_QUEUE = 'business-invite-emails';
export const MAX_EMAIL_ATTEMPTS = 6;
export const SEND_LEASE_MS = 120_000;
// Resend's deduplication window is 24h. Leave an hour for clock/network drift.
export const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const retryDelay = (attempt: number) =>
  Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60 * 1000);
export const deliveryJobId = (id: string) => `invite-email-${id}`;
export const deliveryIdempotencyKey = (id: string) => `business-invite/${id}`;
