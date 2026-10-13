import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
@Catch(HttpException, Prisma.PrismaClientKnownRequestError)
export class TaskErrorFilter implements ExceptionFilter {
  catch(
    error: HttpException | Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus(),
        original = error.getResponse();
      const body =
        typeof original === 'string' ? { message: original } : original;
      const codes: Record<number, string> = {
        400: 'TASK_VALIDATION_ERROR',
        401: 'AUTHENTICATION_REQUIRED',
        403: 'TASK_ACCESS_DENIED',
        404: 'TASK_NOT_FOUND',
        409: 'TASK_CONFLICT',
        413: 'TASK_IMAGE_TOO_LARGE',
        415: 'TASK_IMAGE_UNSUPPORTED',
        503: 'TASK_SERVICE_UNAVAILABLE',
      };
      return response.status(status).json({
        code: codes[status] ?? 'TASK_REQUEST_ERROR',
        ...body,
        statusCode: status,
      });
    }
    const conflict = ['P2002', 'P2034'].includes(error.code);
    return response.status(conflict ? 409 : 503).json({
      code: conflict ? 'TASK_CONCURRENT_CHANGE' : 'TASK_STORAGE_UNAVAILABLE',
      message: conflict
        ? 'Concurrent change; refresh and retry'
        : 'Unable to process task request; please retry',
      statusCode: conflict ? 409 : 503,
    });
  }
}
