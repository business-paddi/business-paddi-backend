import { Injectable, Logger } from '@nestjs/common';
import { deserialize, serialize } from 'node:v8';
import { RedisService } from './redis.service';

// Versions come from the primary database, never from a cached authorization decision.
// Old-version keys expire naturally; a late cache fill cannot overwrite a newer version.
@Injectable()
export class ReadCacheService {
  private readonly logger = new Logger(ReadCacheService.name);
  private readonly pending = new Map<string, Promise<unknown>>();
  private lastWarning = 0;
  private readonly ttlSeconds = 300;
  private readonly timeoutMs = 100;

  constructor(private readonly redis: RedisService) {}

  async remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const pending = this.load(key, load);
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(key);
    }
  }

  private async load<T>(key: string, load: () => Promise<T>): Promise<T> {
    const value = await load(); // Do not cache errors or failed authorization.
    if (this.redis.client.isReady) {
      try {
        await this.bounded(
          this.redis.client.set(key, serialize(value).toString('base64'), {
            EX: this.ttlSeconds,
          }),
        );
      } catch {
        this.warn();
      }
    }
    return value;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    if (!this.redis.client.isReady) return undefined;
    try {
      const value = await this.bounded(this.redis.client.get(key));
      // V8 serialization preserves Date values used by internal access consumers.
      return value === null
        ? undefined
        : (deserialize(Buffer.from(value, 'base64')) as T);
    } catch {
      this.warn();
      return undefined;
    }
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Cache timeout')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private warn() {
    if (Date.now() - this.lastWarning > 60_000) {
      this.lastWarning = Date.now();
      this.logger.warn('Read cache unavailable; using the database');
    }
  }
}
