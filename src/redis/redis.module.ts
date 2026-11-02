import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { ReadCacheService } from './read-cache.service';

@Global()
@Module({
  providers: [RedisService, ReadCacheService],
  exports: [RedisService, ReadCacheService],
})
export class RedisModule {}
