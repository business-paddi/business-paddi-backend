import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
@Catch()
export class InventoryErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const raw = error.getResponse();
      const body =
        typeof raw === 'object'
          ? (raw as Record<string, unknown>)
          : { message: raw };
      return response.status(status).json({
        statusCode: status,
        code:
          body.code ??
          (status === 400
            ? 'VALIDATION_ERROR'
            : status === 403
              ? 'FORBIDDEN'
              : status === 401
                ? 'UNAUTHORIZED'
                : status === 404
                  ? 'NOT_FOUND'
                  : 'REQUEST_FAILED'),
        message: body.message ?? body,
        fieldErrors: body.fieldErrors ?? {},
      });
    }
    const detail =
      error && typeof error === 'object'
        ? (error as Record<string, unknown>)
        : {};
    const meta =
      detail.meta && typeof detail.meta === 'object'
        ? (detail.meta as Record<string, unknown>)
        : {};
    const target = JSON.stringify(meta.target ?? meta);
    const status =
      detail.code === 'P2002'
        ? 409
        : detail.code === 'P2025'
          ? 404
          : typeof detail.code === 'string' &&
              ['P2003', 'P2004'].includes(detail.code)
            ? 400
            : 500;
    const code =
      detail.code === 'P2002'
        ? target.includes('barcode')
          ? 'BARCODE_EXISTS'
          : target.includes('nameKey')
            ? 'CATEGORY_EXISTS'
            : 'DUPLICATE_RECORD'
        : status === 404
          ? 'NOT_FOUND'
          : status === 400
            ? 'INVALID_RELATIONSHIP'
            : 'INTERNAL_ERROR';
    response.status(status).json({
      statusCode: status,
      code,
      message:
        status === 500
          ? 'Internal server error'
          : code === 'BARCODE_EXISTS'
            ? 'Barcode already exists in this business'
            : code === 'CATEGORY_EXISTS'
              ? 'Category name already exists in this business'
              : 'Invalid or conflicting inventory record',
      fieldErrors: {},
    });
  }
}
