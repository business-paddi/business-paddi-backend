import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class BusinessErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      return response
        .status(exception.getStatus())
        .json(
          typeof body === 'string'
            ? { statusCode: exception.getStatus(), message: body }
            : body,
        );
    }
    const code =
      typeof exception === 'object' && exception !== null && 'code' in exception
        ? exception.code
        : undefined;
    const status =
      code === 'P2002'
        ? HttpStatus.CONFLICT
        : code === 'P2025'
          ? HttpStatus.NOT_FOUND
          : code === 'P2003' || code === 'P2004'
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      status === HttpStatus.CONFLICT
        ? 'Duplicate record in this business'
        : status === HttpStatus.NOT_FOUND
          ? 'Record not found'
          : status === HttpStatus.BAD_REQUEST
            ? 'Invalid business relationship or record'
            : 'Internal server error';
    response.status(status).json({
      statusCode: status,
      message,
      error:
        status === HttpStatus.CONFLICT
          ? 'Conflict'
          : status === HttpStatus.NOT_FOUND
            ? 'Not Found'
            : status === HttpStatus.BAD_REQUEST
              ? 'Bad Request'
              : 'Internal Server Error',
    });
  }
}
