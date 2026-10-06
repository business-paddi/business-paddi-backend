import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client: RedisClientType;

  constructor(configService: ConfigService) {
    this.client = createClient({
      url: configService.getOrThrow<string>('REDIS_URL'),
    });

    this.client.on('error', (error: Error) => {
      this.logger.error('Redis connection error', error.stack);
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }
}
