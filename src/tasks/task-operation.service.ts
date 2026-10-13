import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { conflict, digest } from './task.utils';
@Injectable()
export class TaskOperationService {
  readonly secret: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<string>('VERIFICATION_CODE_PEPPER');
  }
  async run<T>(
    userId: string,
    key: string | undefined,
    request: unknown,
    work: (db: Prisma.TransactionClient) => Promise<T>,
  ) {
    if (key !== undefined && !/^[\x21-\x7e]{1,100}$/.test(key))
      throw new BadRequestException('Invalid Idempotency-Key');
    return this.prisma.$transaction(
      async (db) => {
        if (key) {
          await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task:${userId}:${key}`},0))::text`;
          const previous = await db.taskOperation.findUnique({
            where: { userId_key: { userId, key } },
          });
          if (previous) {
            if (previous.hash !== digest(request))
              conflict('IDEMPOTENCY_CONFLICT');
            return previous.result as T;
          }
        }
        const result = await work(db);
        if (key)
          await db.taskOperation.create({
            data: {
              userId,
              key,
              hash: digest(request),
              result: JSON.parse(
                JSON.stringify(result),
              ) as Prisma.InputJsonValue,
            },
          });
        return result;
      },
      { maxWait: 15000, timeout: 90000 },
    );
  }
}
