import {
  INestApplication,
  ValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { AccessTokenGuard } from '../auth-guard/access-token.guard';
import {
  checkRevision,
  money,
  pagination,
  range,
  revision,
  stockStatus,
} from './inventory.helpers';
import type { Server } from 'node:http';

describe('Inventory HTTP contracts', () => {
  let app: INestApplication<Server>;
  const inventory = {
    createProduct: jest.fn(),
    editProduct: jest.fn(),
    barcode: jest.fn(),
    completeSale: jest.fn(),
    saveCart: jest.fn(),
    deleteCategory: jest.fn(),
    products: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [{ provide: InventoryService, useValue: inventory }],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context
            .switchToHttp()
            .getRequest<{ auth: { userId: string } }>().auth = { userId: 'u' };
          return true;
        },
      })
      .compile();
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
  const product = {
    categoryId: 'c',
    name: 'Soap',
    barcode: '000123',
    purchaseCostMinor: 100,
    sellingPriceMinor: 200,
  };
  it('requires a category and rejects fractional stock and spoofed actors', async () => {
    for (const input of [
      { ...product, categoryId: undefined },
      { ...product, openingUnits: 1.5 },
      { ...product, actorName: 'Admin' },
    ]) {
      const response = await request(app.getHttpServer())
        .post('/api/businesses/b/inventory/products')
        .send(input)
        .expect(400);
      expect((response.body as { code: string }).code).toBe('VALIDATION_ERROR');
    }
    expect(inventory.createProduct).not.toHaveBeenCalled();
  });
  it('preserves barcode strings and defaults opening stock to zero', async () => {
    inventory.createProduct.mockResolvedValue({
      product: { id: 'p', barcode: '000123' },
      revision: 1,
    });
    await request(app.getHttpServer())
      .post('/api/businesses/b/inventory/products')
      .send(product)
      .expect(201);
    expect(inventory.createProduct).toHaveBeenCalledWith(
      'u',
      'b',
      expect.objectContaining({ barcode: '000123', openingUnits: 0 }),
    );
  });
  it('uses exact barcode lookup instead of treating by-barcode as an ID', async () => {
    inventory.barcode.mockResolvedValue({ product: { id: 'p' } });
    await request(app.getHttpServer())
      .get('/api/businesses/b/inventory/products/by-barcode?barcode=000123')
      .expect(200);
    expect(inventory.barcode).toHaveBeenCalledWith('u', 'b', '000123');
    await request(app.getHttpServer())
      .get('/api/businesses/b/inventory/products/by-barcode')
      .expect(400);
  });
  it('requires revisions and forbids direct quantity edits', async () => {
    await request(app.getHttpServer())
      .patch('/api/businesses/b/inventory/products/p')
      .send({ name: 'New' })
      .expect(428);
    await request(app.getHttpServer())
      .patch('/api/businesses/b/inventory/products/p')
      .send({ expectedRevision: 1, availableQuantity: 500 })
      .expect(400);
    inventory.editProduct.mockResolvedValue({ revision: 2 });
    await request(app.getHttpServer())
      .patch('/api/businesses/b/inventory/products/p')
      .set('If-Match', '"1"')
      .send({ name: 'New' })
      .expect(200);
    expect(inventory.editProduct).toHaveBeenCalledWith(
      'u',
      'b',
      'p',
      expect.objectContaining({ name: 'New' }),
      1,
    );
  });
  it('bounds pagination and rejects malformed stock filters', async () => {
    await request(app.getHttpServer())
      .get('/api/businesses/b/inventory/products?limit=101')
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/businesses/b/inventory/products?stockStatus=anything')
      .expect(400);
  });
  it('supports empty carts at initial revision zero', async () => {
    inventory.saveCart.mockResolvedValue({
      cart: { lines: [], revision: 1 },
      revision: 1,
    });
    await request(app.getHttpServer())
      .put('/api/businesses/b/inventory/cart')
      .send({ lines: [], expectedRevision: 0 })
      .expect(200);
    expect(inventory.saveCart).toHaveBeenCalledWith(
      'u',
      'b',
      expect.objectContaining({ lines: [] }),
      0,
    );
  });
  it('uses If-Match for category deletion and responds with 204', async () => {
    await request(app.getHttpServer())
      .delete('/api/businesses/b/inventory/categories/c')
      .set('If-Match', '1')
      .expect(204);
    expect(inventory.deleteCategory).toHaveBeenCalledWith('u', 'b', 'c', 1);
  });
});

describe('Inventory arithmetic, dates and cursors', () => {
  it('rejects imprecise money and stale revisions', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => money(1.5)).toThrow();
    expect(() => checkRevision(2, 1)).toThrow();
    expect(() => revision(1, '"2"')).toThrow();
  });
  it('treats zero stock separately from low stock at the threshold', () => {
    expect(stockStatus(0, 5)).toBe('out_of_stock');
    expect(stockStatus(5, 5)).toBe('low_stock');
    expect(stockStatus(6, 5)).toBe('in_stock');
  });
  it('uses Lagos midnight and exclusive end for today', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T23:30:00Z'));
    const result = range({ period: 'today' });
    expect(result.from?.toISOString()).toBe('2026-10-10T23:00:00.000Z');
    expect(result.to?.toISOString()).toBe('2026-10-11T23:00:00.000Z');
    jest.useRealTimers();
  });
  it('encodes a stable tie-breaker and rejects using a cursor with different filters', () => {
    const page = pagination({ limit: 1 }, { businessId: 'b' }, 'name', 'asc');
    const result = page.finish(
      [
        { id: '1', name: 'Same' },
        { id: '2', name: 'Same' },
      ],
      2,
    );
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    const next = pagination(
      { limit: 1, cursor: result.nextCursor! },
      { businessId: 'b' },
      'name',
      'asc',
    );
    expect(next.args.where.AND[1]).toEqual({
      OR: [{ name: { gt: 'Same' } }, { name: 'Same', id: { gt: '1' } }],
    });
    expect(() =>
      pagination(
        { limit: 1, cursor: result.nextCursor! },
        { businessId: 'other' },
        'name',
        'asc',
      ),
    ).toThrow();
  });
});
