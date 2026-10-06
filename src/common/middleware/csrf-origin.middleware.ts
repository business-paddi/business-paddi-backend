import { ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfOriginMiddleware(allowedOrigins: ReadonlySet<string>) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) return next();
    const origin = request.get('origin');
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) {
      return next(new ForbiddenException('Cross-site request rejected'));
    }
    next();
  };
}
