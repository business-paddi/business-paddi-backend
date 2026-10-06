import type { Request } from 'express';
import type { RequestWithContext } from '../middleware/request-context.middleware';
import { normalizeIpAddress } from './ip-address';

export interface RequestMetadata {
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string;
  path: string;
}

export function getRequestMetadata(request: Request): RequestMetadata {
  const contextualRequest = request as Partial<RequestWithContext>;

  return {
    requestId: contextualRequest.requestId ?? null,
    ipAddress: normalizeIpAddress(
      request.ip ?? request.socket.remoteAddress ?? null,
    ),
    userAgent: request.get('user-agent') ?? null,
    method: request.method,
    path: request.originalUrl,
  };
}
