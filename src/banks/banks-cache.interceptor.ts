import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { tap } from 'rxjs';

@Injectable()
export class BanksCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap({
        next: () => response.setHeader('Cache-Control', 'public, max-age=300'),
        error: () => response.setHeader('Cache-Control', 'no-store'),
      }),
    );
  }
}
