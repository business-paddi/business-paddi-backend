import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  BANK_CATALOGUE_SNAPSHOT,
  RETIRED_BANKS,
} from './bank-catalogue.snapshot';
import type { Bank } from './bank-catalogue.types';
import { BanksModule } from './banks.module';
import { BanksService } from './banks.service';

describe('maintained bank catalogue', () => {
  const service = new BanksService();

  it('preserves the complete imported snapshot and globally unique stable IDs', () => {
    const { items } = service.list();
    expect(items).toHaveLength(256);
    expect(new Set(items.map((bank) => bank.id)).size).toBe(256);
    expect(
      new Set([...items, ...RETIRED_BANKS].map((bank) => bank.id)).size,
    ).toBe(items.length + RETIRED_BANKS.length);
    expect(items.every((bank) => typeof bank.code === 'string')).toBe(true);
    expect(items.map((bank) => bank.id).sort()).toEqual(
      BANK_CATALOGUE_SNAPSHOT.map((bank) => bank.id).sort(),
    );
    expect(items.map((bank) => bank.name)).toEqual(
      items
        .map((bank) => bank.name)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
  });

  it('preserves leading zeroes and the pinned Guaranty Trust identity', () => {
    expect(service.list({ q: 'guaranty-trust-bank' }).items).toEqual([
      {
        id: 'bp-bank-9',
        name: 'Guaranty Trust Bank',
        code: '058',
        slug: 'guaranty-trust-bank',
        country: 'Nigeria',
        currency: 'NGN',
        type: 'nuban',
      },
    ]);
    expect(
      service
        .list({ q: '090629' })
        .items.some((bank) => bank.code === '090629'),
    ).toBe(true);
  });

  it('retains distinct banks sharing a code instead of deduplicating by code', () => {
    const matches = service
      .list({ q: '057' })
      .items.filter((bank) => bank.code === '057');
    expect(matches.length).toBeGreaterThan(1);
    expect(new Set(matches.map((bank) => bank.id)).size).toBe(matches.length);
  });

  it('combines trimmed case-insensitive filters and keeps identities stable', () => {
    const bank = service.list({
      q: ' GUARANTY ',
      country: ' nigeria ',
      currency: ' ngn ',
    }).items[0];
    expect(bank.id).toBe('bp-bank-9');
    expect(
      service.list({ q: '058', country: 'Nigeria', currency: 'NGN' }).items,
    ).toContainEqual(bank);
    expect(service.list({ q: 'not-a-real-bank' }).items).toEqual([]);
    expect(service.list({ country: 'Ghana' }).items).toEqual([]);
    expect(service.list({ currency: 'EUR' }).items).toEqual([]);
    expect(
      service.list({ currency: 'USD' }).items.map((bank) => bank.id),
    ).toEqual(['bp-bank-65']);
    expect(service.list({ q: ' ', country: ' ', currency: ' ' })).toEqual(
      service.list(),
    );
  });

  it('does not let response mutation alter the maintained snapshot or subsequent calls', () => {
    const result = service.list();
    const first = { ...result.items[0] };
    Object.assign(result.items[0], { code: 'changed' });
    result.items.reverse();
    expect(service.list().items[0]).toEqual(first);
  });
});

describe('GET /api/banks HTTP contract', () => {
  let app: INestApplication<Server>;
  let service: BanksService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [BanksModule],
    }).compile();
    service = module.get(BanksService);
    app = module.createNestApplication<INestApplication<Server>>({
      logger: false,
    });
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
  afterAll(async () => {
    await app.close();
  });

  it('lists all banks without login, database access, provider calls or credentials', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Provider calls prohibited'));
    try {
      const response = await request(app.getHttpServer())
        .get('/api/banks')
        .expect(200);
      expect(Object.keys(response.body as object)).toEqual(['items']);
      expect((response.body as { items: Bank[] }).items).toHaveLength(256);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('validates and applies name, slug, code, country and currency queries over HTTP', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/banks')
      .query({
        q: ' GUARANTY-TRUST-BANK ',
        country: ' nigeria ',
        currency: ' ngn ',
      })
      .expect(200);
    expect(response.body).toEqual({
      items: [
        {
          id: 'bp-bank-9',
          name: 'Guaranty Trust Bank',
          code: '058',
          slug: 'guaranty-trust-bank',
          country: 'Nigeria',
          currency: 'NGN',
          type: 'nuban',
        },
      ],
    });
    const code = await request(app.getHttpServer())
      .get('/api/banks?q=058')
      .expect(200);
    expect(
      (code.body as { items: Bank[] }).items.some(
        (bank) => bank.code === '058',
      ),
    ).toBe(true);
    const missing = await request(app.getHttpServer())
      .get('/api/banks?currency=EUR')
      .expect(200);
    expect(missing.body).toEqual({ items: [] });
  });

  it.each([
    ['currency=naira'],
    ['type=nuban'],
    ['q=a&q=b'],
    ['q=' + 'x'.repeat(101)],
    ['country=' + 'x'.repeat(81)],
  ])(
    'rejects invalid queries with the existing 400 envelope: %s',
    async (query) => {
      const response = await request(app.getHttpServer())
        .get('/api/banks?' + query)
        .expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        message: expect.any(Array) as unknown,
      });
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );

  it('returns empty/blank queries as the full catalogue', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/banks?q=%20&country=&currency=')
      .expect(200);
    expect((response.body as { items: Bank[] }).items).toHaveLength(256);
  });

  it('uses the existing sanitized 500 envelope and does not cache failures', async () => {
    const failure = jest.spyOn(service, 'list').mockImplementationOnce(() => {
      throw new Error('internal detail');
    });
    try {
      const response = await request(app.getHttpServer())
        .get('/api/banks')
        .expect(500);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      failure.mockRestore();
    }
  });
});
