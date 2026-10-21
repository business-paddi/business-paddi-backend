import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
@Catch(HttpException, Prisma.PrismaClientKnownRequestError)
export class PayrollErrorFilter implements ExceptionFilter {
  catch(
    error: HttpException | Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus(),
        body = error.getResponse();
      return response.status(status).json({
        code:
          status === 403 ? 'PAYROLL_ACCESS_DENIED' : 'PAYROLL_REQUEST_ERROR',
        ...(typeof body === 'string' ? { message: body } : body),
        statusCode: status,
      });
    }
    const conflict =
      ['P2002', 'P2034'].includes(error.code) ||
      JSON.stringify(error.meta ?? {}).includes('23P01');
    return response.status(conflict ? 409 : 503).json({
      code: conflict
        ? 'PAYROLL_CONCURRENT_CHANGE'
        : 'PAYROLL_STORAGE_UNAVAILABLE',
      message: conflict
        ? 'Concurrent change; refresh and retry'
        : 'Unable to process payroll; retry later',
      statusCode: conflict ? 409 : 503,
    });
  }
}
