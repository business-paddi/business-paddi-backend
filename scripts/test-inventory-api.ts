import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { InventoryQuery, PageQuery } from '../src/inventory/inventory.dto';
import type { PrismaService } from '../src/database/prisma.service';
import type { BusinessAccessService } from '../src/business/business-access.service';
import { allowedPermissions } from '../src/business-foundation/permission-catalog';
import { databaseErrorSummary } from './database-error';
import { HttpException } from '@nestjs/common';

function errorCode(error: unknown): unknown {
  if (!(error instanceof HttpException)) return undefined;
  const response = error.getResponse();
  return typeof response === 'object'
    ? (response as Record<string, unknown>).code
    : undefined;
}
type SaleResult = Awaited<ReturnType<InventoryService['completeSale']>>;

// Uses a uniquely named temporary schema. Never inserts or deletes public data.
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const schema = `inventory_test_${randomBytes(8).toString('hex')}`;
  assert.match(schema, /^inventory_test_[a-f0-9]{16}$/);
  const config = {
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
    query_timeout: 30000,
  };
  const admin = new Pool(config);
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let passed = 0;
  const check = (label: string, value: unknown) => {
    assert.ok(value, label);
    passed++;
    console.log(`PASS: ${label}`);
  };
  const rejects = async (
    label: string,
    fn: () => Promise<unknown>,
    code?: string,
  ) => {
    try {
      await fn();
    } catch (error: unknown) {
      if (code) assert.equal(errorCode(error), code);
      check(label, true);
      return;
    }
    throw new Error(`${label}: expected failure`);
  };
  try {
    console.log(
      'Checking PostgreSQL connectivity and creating isolated inventory test schema...',
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // Neon's pooled endpoint rejects search_path startup options. The direct
    // endpoint supports per-connection schema isolation for this test only.
    const directUrl = new URL(config.connectionString);
    directUrl.hostname = directUrl.hostname.replace('-pooler.', '.');
    const scoped = {
      ...config,
      connectionString: directUrl.toString(),
      options: `-c search_path=${schema}`,
    };
    pool = new Pool(scoped);
    const current = await pool.query<{ schema: string }>(
      'SELECT current_schema() AS schema',
    );
    assert.equal(current.rows[0].schema, schema);
    await pool.query(`CREATE TABLE "Business" ("id" TEXT PRIMARY KEY, "name" TEXT);
      CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT);
      CREATE TABLE "UserPreference" ("userId" TEXT PRIMARY KEY);
      CREATE TABLE "Permission" ("key" TEXT PRIMARY KEY);
      CREATE TABLE "Role" ("id" TEXT PRIMARY KEY, "type" TEXT, "status" TEXT, "key" TEXT);
      CREATE TABLE "RolePermission" ("roleId" TEXT, "permission" TEXT, PRIMARY KEY ("roleId", "permission"));
      CREATE TABLE "RoleDeniedPermission" ("roleId" TEXT, "permission" TEXT, PRIMARY KEY ("roleId", "permission"));
      INSERT INTO "Role" VALUES ('owner','system','active','owner'),('admin','system','active','admin'),('finance','system','active','finance_manager'),('accountant','system','active','accountant'),('viewer','system','active','viewer');`);
    const foundationSql = await readFile(
      'prisma/migrations/20261008090000_business_foundation/migration.sql',
      'utf8',
    );
    const guardStart = foundationSql.indexOf(
      'CREATE FUNCTION protect_system_permissions()',
    );
    const guardEnd = foundationSql.indexOf('COMMIT;', guardStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart);
    const catalogConstraint = foundationSql
      .split(/\r?\n/)
      .find((line) =>
        line.startsWith(
          'ALTER TABLE "Permission" ADD CONSTRAINT "Permission_catalog_check"',
        ),
      );
    assert.ok(catalogConstraint);
    await pool.query(catalogConstraint);
    await pool.query(foundationSql.slice(guardStart, guardEnd));
    await pool.query(
      await readFile(
        'prisma/migrations/20261011190000_inventory_sales/migration.sql',
        'utf8',
      ),
    );
    await pool.query(
      `INSERT INTO "Business" VALUES ('b','Test shop'),('foreign','Other shop'); INSERT INTO "User" VALUES ('u','Ada'),('v','Ben');`,
    );
    const grants = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM "RolePermission"',
    );
    check(
      'migration extends protected system roles with exactly the intended inventory grants',
      grants.rows[0].count === 19,
    );
    await rejects('system guard rejects inventory management for viewer', () =>
      pool!.query(
        `INSERT INTO "RolePermission" VALUES ('viewer','inventory:manage')`,
      ),
    );
    await rejects('system grants remain immutable', () =>
      pool!.query(`DELETE FROM "RolePermission" WHERE "roleId"='owner'`),
    );
    await rejects('closed catalog still rejects unknown permission keys', () =>
      pool!.query(`INSERT INTO "Permission" VALUES ('inventory:unknown')`),
    );
    if (process.argv.includes('--migration-only')) {
      console.log(`${passed} inventory migration checks passed.`);
      return;
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    const scope = await prisma.$queryRaw<
      { schema: string }[]
    >`SELECT current_schema()::text AS schema`;
    assert.equal(scope[0].schema, schema);
    const requireAccess = (userId: string, businessId: string) => {
      if (
        !['u', 'v'].includes(userId) ||
        !['b', 'foreign'].includes(businessId)
      )
        throw new Error('Forbidden');
      return Promise.resolve({
        permissions: [...allowedPermissions],
        member: { business: { name: 'Test shop' } },
      });
    };
    const access = {
      require: requireAccess,
      lock: requireAccess,
    } as unknown as BusinessAccessService;
    const service = new InventoryService(
      prisma as unknown as PrismaService,
      access,
    );
    const summary = await service.summary('u', 'b');
    check(
      'empty business remains empty and asks for its first category',
      summary.empty && summary.needsFirstCategory && summary.productCount === 0,
    );
    const { category } = await service.createCategory('u', 'b', {
      name: 'Food',
    });
    await rejects('case-insensitive duplicate category name rejected', () =>
      service.createCategory('u', 'b', { name: 'food' }),
    );
    const foreign = await service.createCategory('u', 'foreign', {
      name: 'Foreign',
    });
    await rejects(
      'foreign category cannot be attached to a product',
      () =>
        service.createProduct('u', 'b', {
          categoryId: foreign.category.id,
          name: 'Invalid',
          purchaseCostMinor: 100,
          sellingPriceMinor: 200,
          openingUnits: 1,
          lowStockThreshold: 1,
        }),
      'CATEGORY_REQUIRED',
    );
    const createdProduct = await service.createProduct('u', 'b', {
      categoryId: category.id,
      name: 'Rice',
      barcode: '000123',
      purchaseCostMinor: 100,
      sellingPriceMinor: 200,
      openingUnits: 5,
      lowStockThreshold: 2,
    });
    const id = createdProduct.product.id;
    check(
      'opening stock has an atomic ledger entry',
      createdProduct.movementIds.length === 1 &&
        createdProduct.product.availableQuantity === 5,
    );
    check(
      'leading-zero barcode lookup is exact',
      (await service.barcode('u', 'b', '000123')).product.id === id,
    );
    await rejects(
      'barcode miss is not a successful empty result',
      () => service.barcode('u', 'b', '123'),
      'BARCODE_NOT_FOUND',
    );
    await rejects('duplicate barcode rejected', () =>
      service.createProduct('u', 'b', {
        categoryId: category.id,
        name: 'Duplicate',
        barcode: '000123',
        purchaseCostMinor: 100,
        sellingPriceMinor: 200,
        openingUnits: 0,
        lowStockThreshold: 0,
      }),
    );
    await rejects(
      'nonempty category cannot be deleted',
      () => service.deleteCategory('u', 'b', category.id, 1),
      'CATEGORY_NOT_EMPTY',
    );
    const lines = [{ productId: id, quantity: 4 }];
    const [first, second] = await Promise.all([
      service.quote('u', 'b', { lines }),
      service.quote('v', 'b', { lines }),
    ]);
    const input = (
      quote: Awaited<ReturnType<InventoryService['quote']>>['quote'],
    ) => ({
      lines,
      quoteId: quote.id,
      quoteRevision: 1,
      paymentMethod: 'cash' as const,
      tenderMinor: 1000,
    });
    const one = input(first.quote),
      two = input(second.quote);
    const outcomes = await Promise.allSettled([
      service.completeSale('u', 'b', one, 'inventory_sale_key_0001'),
      service.completeSale('v', 'b', two, 'inventory_sale_key_0002'),
    ]);
    if (outcomes.every((result) => result.status === 'rejected')) {
      for (const result of outcomes)
        if (result.status === 'rejected')
          console.error(databaseErrorSummary(result.reason));
    }
    check(
      'two tills cannot oversell: only one checkout commits',
      outcomes.filter((result) => result.status === 'fulfilled').length === 1,
    );
    check(
      'concurrent loser gets insufficient stock',
      outcomes.some(
        (result) =>
          result.status === 'rejected' &&
          errorCode(result.reason) === 'INSUFFICIENT_STOCK',
      ),
    );
    const winnerIndex = outcomes.findIndex(
      (result) => result.status === 'fulfilled',
    );
    const winner = outcomes[winnerIndex] as PromiseFulfilledResult<SaleResult>;
    const winnerUser = winnerIndex === 0 ? 'u' : 'v';
    const winnerInput = winnerIndex === 0 ? one : two;
    const winnerKey =
      winnerIndex === 0 ? 'inventory_sale_key_0001' : 'inventory_sale_key_0002';
    const receipt = winner.value.sale;
    check(
      'sale snapshots totals and computes cash change',
      receipt.totalMinor === 800 &&
        receipt.totalCostMinor === 400 &&
        receipt.changeMinor === 200,
    );
    check(
      'only four units were deducted',
      (await service.getProduct('u', 'b', id)).product.availableQuantity === 1,
    );
    const replay = await service.completeSale(
      winnerUser,
      'b',
      winnerInput,
      winnerKey,
    );
    check(
      'retry returns the original sale without additional deductions',
      replay.sale.id === receipt.id &&
        (await prisma.inventorySale.count()) === 1,
    );
    await rejects(
      'same key cannot be reused for a changed payload',
      () =>
        service.completeSale(
          winnerUser,
          'b',
          { ...winnerInput, tenderMinor: 1200 },
          winnerKey,
        ),
      'IDEMPOTENCY_CONFLICT',
    );
    const shortages = await service.shortages(
      'u',
      'b',
      id,
      new InventoryQuery(),
    );
    check(
      'low-stock interval starts after sale',
      shortages.items.length === 1 &&
        shortages.items[0].classification === 'low_stock' &&
        shortages.items[0].endedAt === null,
    );
    const receive = {
      quantity: 5,
      purchaseCostMinor: 150,
      supplier: 'Supplier',
    };
    const received = await service.receive(
      'u',
      'b',
      id,
      receive,
      'inventory_receive_key_01',
    );
    const retried = await service.receive(
      'u',
      'b',
      id,
      receive,
      'inventory_receive_key_01',
    );
    check(
      'receiving retry does not duplicate stock or ledger',
      received.receipt.id === retried.receipt.id &&
        retried.product.availableQuantity === 6 &&
        (await prisma.inventoryReceipt.count()) === 1,
    );
    check(
      'receiving closes the shortage interval',
      (await service.shortages('u', 'b', id, new InventoryQuery())).items[0]
        .endedAt !== null,
    );
    const other = await service.createCategory('u', 'b', { name: 'Pantry' });
    const edit = await service.editProduct(
      'u',
      'b',
      id,
      {
        categoryId: other.category.id,
        name: 'New rice',
        sellingPriceMinor: 300,
        reason: 'Price review',
      },
      received.product.revision,
    );
    check(
      'moving categories preserves product ID',
      edit.product.id === id && edit.product.categoryId === other.category.id,
    );
    const savedReceipt = (await service.sale('u', 'b', receipt.id)).sale;
    check(
      'saved receipt is unchanged after name/category/price edits',
      savedReceipt.lines[0].productName === 'Rice' &&
        savedReceipt.lines[0].categoryName === 'Food' &&
        savedReceipt.lines[0].sellingPriceMinor === 200 &&
        savedReceipt.totalMinor === 800,
    );
    await rejects(
      'stale catalogue revision rejected',
      () => service.editProduct('u', 'b', id, { name: 'Stale' }, 1),
      'REVISION_CONFLICT',
    );
    await rejects(
      'foreign business cannot read product',
      () => service.getProduct('u', 'foreign', id),
      'PRODUCT_NOT_FOUND',
    );
    const prices = await service.movements(
      'u',
      'b',
      { ...new InventoryQuery(), productId: id },
      true,
    );
    check(
      'price history contains actual receive and edit changes',
      prices.total === 2,
    );
    const quote = await service.quote('u', 'b', {
      lines: [{ productId: id, quantity: 1, expectedSellingPriceMinor: 200 }],
    });
    check(
      'quotes flag price changes without reserving stock',
      quote.quote.pricesChanged &&
        (await service.getProduct('u', 'b', id)).product.availableQuantity ===
          6,
    );
    await service.saveCart(
      'u',
      'b',
      { lines: [{ productId: id, quantity: 1 }] },
      (await service.cart('u', 'b')).cart.revision,
    );
    await rejects(
      'changing the draft after quoting prevents accidental clearing',
      () =>
        service.completeSale(
          'u',
          'b',
          {
            lines: [{ productId: id, quantity: 1 }],
            quoteId: quote.quote.id,
            quoteRevision: 1,
            paymentMethod: 'cash',
            tenderMinor: 300,
          },
          'inventory_sale_key_0003',
        ),
      'REVISION_CONFLICT',
    );
    const freshQuote = await service.quote('u', 'b', {
      lines: [{ productId: id, quantity: 1 }],
    });
    const transfer = {
      lines: [{ productId: id, quantity: 1 }],
      quoteId: freshQuote.quote.id,
      quoteRevision: 1,
      paymentMethod: 'transfer' as const,
    };
    await rejects(
      'unconfirmed transfer makes no stock deductions',
      () =>
        service.completeSale('u', 'b', transfer, 'inventory_transfer_key_1'),
      'PAYMENT_NOT_CONFIRMED',
    );
    check(
      'payment failure rolls back stock',
      (await service.getProduct('u', 'b', id)).product.availableQuantity === 6,
    );
    const completed = await service.completeSale(
      'u',
      'b',
      { ...transfer, paymentConfirmed: true },
      'inventory_transfer_key_1',
    );
    check(
      'transfer receipt labels manual confirmation accurately',
      completed.sale.paymentStatus === 'manually_confirmed',
    );
    check(
      'successful checkout clears the saved cart',
      (await service.cart('u', 'b')).cart.lines instanceof Array &&
        ((await service.cart('u', 'b')).cart.lines as unknown[]).length === 0,
    );
    const analytics = await service.analytics('u', 'b', {
      ...new InventoryQuery(),
      period: '7d',
    });
    check(
      'analytics zero-fills Lagos daily totals and matches immutable sales',
      analytics.daily.length === 7 &&
        analytics.revenueMinor === 1100 &&
        analytics.daily.reduce((sum, point) => sum + point.revenueMinor, 0) ===
          1100 &&
        analytics.grossProfitMinor === 550,
    );
    const empty = await service.createCategory('u', 'b', { name: 'Delete me' });
    await service.deleteCategory('u', 'b', empty.category.id, 1);
    check(
      'empty category deletion succeeds',
      !(await prisma.inventoryCategory.findUnique({
        where: { id: empty.category.id },
      })),
    );
    await rejects('database rejects ledger mutation', () =>
      prisma!.inventoryMovement.delete({
        where: { id: createdProduct.movementIds[0] },
      }),
    );
    await rejects('database rejects immutable receipt changes', () =>
      prisma!.inventorySale.update({
        where: { id: receipt.id },
        data: { totalMinor: 999 },
      }),
    );
    const categories = await service.categories('u', 'b', {
      ...new PageQuery(),
      limit: 1,
    });
    check(
      'cursor pagination returns a continuation',
      categories.items.length === 1 && !!categories.nextCursor,
    );
    const pageTwo = await service.categories('u', 'b', {
      ...new PageQuery(),
      limit: 1,
      cursor: categories.nextCursor!,
    });
    check(
      'cursor pagination does not repeat the first category',
      pageTwo.items[0].id !== categories.items[0].id,
    );
    console.log(`${passed} inventory database checks passed.`);
  } finally {
    await prisma?.$disconnect();
    await pool?.end();
    if (created) {
      assert.match(schema, /^inventory_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log('Isolated test schema removed; public data untouched.');
    }
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
