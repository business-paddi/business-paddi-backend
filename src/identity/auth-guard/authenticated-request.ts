import type { Request } from 'express';

export interface AuthenticatedPrincipal {
  userId: string;
  userSessionId: string;
  accessTokenId: string;
  // Internal freshness token loaded with the live session check; never sent to clients.
  userCacheRevision?: string;
}

export type AuthenticatedRequest = Request & {
  auth: AuthenticatedPrincipal;
};
