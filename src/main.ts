import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { csrfOriginMiddleware } from './common/middleware/csrf-origin.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);
  const isProduction = configService.get<string>('NODE_ENV') === 'production';
  const frontendOrigin = configService.get<string>(
    'FRONTEND_URL',
    isProduction ? 'https://businesspaddi.com' : 'http://localhost:3000',
  );
  const port = configService.get<number>('PORT', 3001);
  app.set(
    'trust proxy',
    parseTrustProxy(configService.get<string>('TRUST_PROXY')),
  );

  app.enableCors({
    origin: frontendOrigin,
    credentials: true,
  });
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  app.use(csrfOriginMiddleware(new Set([new URL(frontendOrigin).origin])));
  app.enableShutdownHooks();
  app.setGlobalPrefix('api', {
    exclude: [
      { path: '', method: RequestMethod.GET },
      { path: 'health', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(port);
}
void bootstrap();

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops < 1) {
      throw new Error(
        'TRUST_PROXY must be a positive hop count or proxy subnet',
      );
    }
    return hops;
  }
  return value;
}
