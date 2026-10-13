import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { ContactController } from './contact.controller';
import { ContactRateLimitError, ContactService } from './contact.service';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
const body = {
  kind: 'demo',
  name: ' Ada ',
  email: ' ADA@EXAMPLE.TEST ',
  businessName: ' Shop ',
  locations: '2 stores',
  planInterest: 'unsure',
  focus: 'Inventory logs',
  message: 'Hello',
};
describe('Public contact HTTP contract', () => {
  let app: INestApplication<Server>;
  const service = {
    receive: jest.fn(() =>
      Promise.resolve({ requestId: 'r', status: 'received' }),
    ),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ContactController],
      providers: [{ provide: ContactService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());
  it('accepts unauthenticated submissions and preserves frontend fields', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/public/contact-requests')
      .send(body)
      .expect(202);
    expect(response.body).toEqual({ requestId: 'r', status: 'received' });
    expect(service.receive).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        ...body,
        name: 'Ada',
        email: 'ada@example.test',
        businessName: 'Shop',
      }),
      undefined,
    );
  });
  it('validates frontend enums, required fields and limits', async () => {
    for (const changes of [
      { planInterest: 'premium' },
      { focus: 'Random' },
      { name: ' ' },
      { email: 'bad' },
      { message: 'x'.repeat(2001) },
      { to: 'recipient@example.test' },
    ])
      await request(app.getHttpServer())
        .post('/api/public/contact-requests')
        .send({ ...body, ...changes })
        .expect(400);
    expect(service.receive).not.toHaveBeenCalled();
  });
  it('publishes Retry-After on rate limit', async () => {
    service.receive.mockRejectedValueOnce(new ContactRateLimitError(60));
    const response = await request(app.getHttpServer())
      .post('/api/public/contact-requests')
      .send(body)
      .expect(429);
    expect(response.headers['retry-after']).toBe('60');
  });
  it('has no public list or detail endpoint', async () => {
    await request(app.getHttpServer())
      .get('/api/public/contact-requests')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/public/contact-requests/r')
      .expect(404);
  });
  it('persistence failure returns 503 without private error data', async () => {
    const unavailable = new ContactService(
      {
        $transaction: () =>
          Promise.reject(
            new Error('private contact@example.test database details'),
          ),
      } as unknown as PrismaService,
      new ConfigService({ VERIFICATION_CODE_PEPPER: 'test' }),
    );
    try {
      await unavailable.receive('192.0.2.1', {
        ...body,
        email: 'ada@example.test',
      });
      throw new Error('Expected failure');
    } catch (error) {
      expect((error as { getStatus: () => number }).getStatus()).toBe(503);
      expect(
        JSON.stringify((error as { getResponse: () => unknown }).getResponse()),
      ).not.toContain('contact@example.test');
    }
  });
});
