import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type RequestWithContext = Request & {
  requestId: string;
};

export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();

  (request as RequestWithContext).requestId = requestId;
  response.setHeader('X-Request-ID', requestId);

  next();
}
