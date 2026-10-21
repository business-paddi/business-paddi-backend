import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
@Catch()
export class ReferralsErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ReferralsErrorFilter.name);
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return response
        .status(error.getStatus())
        .json(
          typeof body === 'string'
            ? { statusCode: error.getStatus(), message: body }
            : body,
        );
    }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'unknown';
    this.logger.error({ code });
    return response.status(code === 'P2002' ? 409 : 503).json({
      statusCode: code === 'P2002' ? 409 : 503,
      message:
        code === 'P2002'
          ? 'This referral request conflicts with an existing record. Please refresh and retry.'
          : 'Plans and referrals are temporarily unavailable. Please retry.',
    });
  }
}
