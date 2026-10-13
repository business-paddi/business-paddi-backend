import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { InviteEmailDeliveryService } from './invite-email-delivery.service';
import { INVITE_EMAIL_QUEUE, deliveryJobId } from './invite-email.constants';

@Injectable()
export class InviteEmailQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InviteEmailQueue.name);
  private queue?: Queue;
  private worker?: Worker<{ deliveryId?: unknown }>;
  private timer?: NodeJS.Timeout;
  private relaying = false;
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly delivery: InviteEmailDeliveryService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('INVITE_EMAIL_ENABLED') === 'false') return;
    const url = new URL(this.config.getOrThrow<string>('REDIS_URL'));
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
      db: Number(url.pathname.slice(1) || 0),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    this.queue = new Queue(INVITE_EMAIL_QUEUE, {
      prefix: this.config.get<string>('INVITE_EMAIL_QUEUE_PREFIX') ?? 'bull',
      connection: {
        ...connection,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      },
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: { age: 86400, count: 10000 },
        removeOnFail: { age: 604800, count: 10000 },
      },
    });
    this.worker = new Worker<{ deliveryId?: unknown }>(
      INVITE_EMAIL_QUEUE,
      async (job) => {
        if (
          job.name !== 'send-invite' ||
          typeof job.data?.deliveryId !== 'string'
        )
          throw new Error('INVALID_INVITE_EMAIL_JOB');
        await this.delivery.deliver(job.data.deliveryId);
      },
      {
        prefix: this.config.get<string>('INVITE_EMAIL_QUEUE_PREFIX') ?? 'bull',
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 5,
      },
    );
    this.queue.on('error', () =>
      this.logger.warn(
        'Invite email queue unavailable; database outbox retained',
      ),
    );
    this.worker.on('error', () =>
      this.logger.warn(
        'Invite email worker unavailable; database outbox retained',
      ),
    );
    this.timer = setInterval(() => {
      void this.relay();
    }, 10000);
    this.timer.unref();
    void this.relay();
  }

  async relay() {
    if (!this.queue || this.relaying) return;
    this.relaying = true;
    try {
      const now = new Date();
      const deliveries = await this.prisma.inviteEmailDelivery.findMany({
        where: {
          OR: [
            { state: 'pending', nextAttemptAt: { lte: now } },
            { state: 'processing', leaseExpiresAt: { lte: now } },
          ],
        },
        select: { id: true },
        orderBy: { nextAttemptAt: 'asc' },
        take: 100,
      });
      for (const delivery of deliveries) {
        const jobId = deliveryJobId(delivery.id);
        const existing = await this.queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state === 'failed' || state === 'completed')
            await existing.retry(state);
          continue;
        }
        await this.queue.add(
          'send-invite',
          { deliveryId: delivery.id },
          { jobId },
        );
      }
    } catch {
      this.logger.warn(
        'Invite email relay deferred; durable records will be retried',
      );
    } finally {
      this.relaying = false;
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }
}
