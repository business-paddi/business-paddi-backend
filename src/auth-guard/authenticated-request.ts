import type { Request } from 'express';

export interface AuthenticatedPrincipal {
  userId: string;
  userSessionId: string;
  accessTokenId: string;
}

export type AuthenticatedRequest = Request & {
  auth: AuthenticatedPrincipal;
};
