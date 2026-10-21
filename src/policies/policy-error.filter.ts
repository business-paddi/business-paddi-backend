import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { BusinessErrorFilter } from '../business/business-error.filter';

@Catch()
export class PolicyErrorFilter extends BusinessErrorFilter {
  private readonly logger = new Logger(PolicyErrorFilter.name);

  override catch(exception: unknown, host: ArgumentsHost) {
    if (!(exception instanceof HttpException)) {
      const error = exception as {
        name?: string;
        code?: string;
        meta?: { error?: string; code?: string };
      } | null;
      // Do not log request text, SQL, credentials, or employee data.
      this.logger.error({
        name: error?.name,
        code: error?.code,
        databaseCode: error?.meta?.code,
        ...(error?.code === 'P2028' ? { reason: error.meta?.error } : {}),
      });
    }
    return super.catch(exception, host);
  }
}
