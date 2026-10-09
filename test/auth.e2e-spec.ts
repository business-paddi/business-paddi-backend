/**
 * Auth flow e2e. Needs live infra: DATABASE_URL, REDIS_URL, RESEND_KEY,
 * Google config, data/GeoLite2-City.mmdb. Run: npm run test:e2e
 *
 * Fully automated: every route that does not require reading an email code.
 * Email-code steps (verify, 2FA, reset confirm, reauth) are manual — do them
 * once against a dev server with a yopmail address (e.g. okoye@yopmail.com):
 * register -> read 6-digit code at yopmail.com -> verify -> login, then
 * login-verification, password-reset, and security-verification flows per
 * docs/frontend-handoff.md Part C. Use X-Forwarded-For with a Nigerian IP
 * (e.g. 197.210.29.1) to check session city/region/country is populated.
 */
import {
  HttpStatus,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { EmailService } from '../src/email/email.service';

const NIGERIAN_IP = '197.210.29.1';
const stamp = Date.now().toString(36);
const email = `e2e-${stamp}@yopmail.com`;
const password = 'Correct-Horse-99';

describe('Auth (e2e, no email codes)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({
        sendEmailVerification: async () => {},
        sendLoginVerification: async () => {},
        sendPasswordResetCode: async () => {},
        sendSensitiveActionCode: async () => {},
        sendEmailChangeVerification: async () => {},
        sendEmailChangedNotice: async () => {},
        sendPasswordResetNotice: async () => {},
      })
      .compile();

    app = moduleFixture.createNestApplication();
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
    await app.init();
    prisma = app.get(PrismaService);
    agent = request.agent(app.getHttpServer());
  }, 60000);

  afterAll(async () => {
    try {
      if (prisma) await prisma.user.deleteMany({ where: { email } });
    } finally {
      if (app) await app.close();
    }
  });

  it('GET /health returns ok', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, {
      status: 'ok',
    });
  });

  it('POST /api/auth/register sends once and enforces the existing verification cooldown', async () => {
    const body = { email, name: 'E2E User', password };
    const first = await agent
      .post('/api/auth/register')
      .set('X-Forwarded-For', NIGERIAN_IP)
      .send(body)
      .expect(HttpStatus.CREATED);
    expect((first.body as { message: string }).message).toContain(
      'verification code has been sent',
    );
    const second = await agent
      .post('/api/auth/register')
      .send(body)
      .expect(HttpStatus.TOO_MANY_REQUESTS);
    expect((second.body as { statusCode: number }).statusCode).toBe(429);
  });

  it('POST /api/auth/register rejects unknown fields', async () => {
    await agent
      .post('/api/auth/register')
      .send({ email, name: 'X', password, admin: true })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('POST /api/auth/login rejects wrong password without revealing state', async () => {
    const res = await agent
      .post('/api/auth/login')
      .send({ email, password: 'Wrong-Password-1' })
      .expect(HttpStatus.UNAUTHORIZED);
    expect((res.body as { message: string }).message).toBe(
      'Invalid email or password',
    );
  });

  it('POST /api/auth/login blocks unverified email with 403', async () => {
    const res = await agent
      .post('/api/auth/login')
      .send({ email, password })
      .expect(HttpStatus.FORBIDDEN);
    expect((res.body as { message: string }).message).toBe(
      'Email verification is required',
    );
  });

  it('POST /api/auth/email-verification/resend enforces delivery cooldown and accepts an unknown email uniformly', async () => {
    const res = await agent
      .post('/api/auth/email-verification/resend')
      .send({ email })
      .expect(HttpStatus.TOO_MANY_REQUESTS);
    expect((res.body as { statusCode: number }).statusCode).toBe(429);
    await agent
      .post('/api/auth/email-verification/resend')
      .send({ email: `nobody-${stamp}@yopmail.com` })
      .expect(HttpStatus.ACCEPTED);
  });

  it('POST /api/auth/password-reset/request always returns challengeId', async () => {
    const res = await agent
      .post('/api/auth/password-reset/request')
      .send({ email })
      .expect(HttpStatus.ACCEPTED);
    expect((res.body as { challengeId: string }).challengeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('POST /api/auth/refresh without cookie is 401 REFRESH_REJECTED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .expect(HttpStatus.UNAUTHORIZED);
    expect((res.body as { code: string }).code).toBe('REFRESH_REJECTED');
  });

  it('guarded routes 401 without a session', async () => {
    await request(app.getHttpServer())
      .get('/api/businesses')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .post('/api/business-invites/accept')
      .send({ token: 'a'.repeat(64) })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/api/account/me')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/api/sessions')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/api/audit-events')
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('POST /api/auth/logout is idempotent (200 with no session)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .expect(HttpStatus.OK);
    expect((res.body as { message: string }).message).toBe(
      'Logged out successfully',
    );
  });
});
