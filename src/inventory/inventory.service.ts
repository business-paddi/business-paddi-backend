import { Injectable } from '@nestjs/common';
import { Prisma, type InventoryProduct } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/business-access.service';
import type { Permission } from '../business-foundation/permission-catalog';
import {
  CategoryDto,
  CategoryPatchDto,
  ProductDto,
  ProductPatchDto,
  InventoryQuery,
  PageQuery,
  ReceiptDto,
  CartDto,
  QuoteDto,
  SaleDto,
  CartLineDto,
} from './inventory.dto';
import {
  checkRevision,
  fail,
  hash,
  json,
  money,
  pagination,
  productResponse,
  range,
  stockStatus,
} from './inventory.helpers';
import { randomUUID } from 'node:crypto';

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
} as const;
type Db = Prisma.TransactionClient;
type SnapshotLine = {
  productId: string;
  quantity: number;
  productName: string;
  categoryId: string;
  categoryName: string;
  barcode: string | null;
  sku: string | null;
  sellingPriceMinor: number;
  purchaseCostMinor: number;
  revision: number;
  availableQuantity: number;
  totalMinor: number;
  totalCostMinor: number;
  priceChanged: boolean;
  sufficientStock: boolean;
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
  ) {}

  private async mutate<T>(
    userId: string,
    businessId: string,
    permission: Permission,
    fn: (
      db: Db,
      actor: { id: string; name: string },
      businessName: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (db) => {
        const access = await this.access.lock(
          userId,
          businessId,
          [permission],
          db,
        );
        // All stock/catalogue writes acquire the same business lock. This also
        // serializes category deletion and checkout against product edits/receiving.
        await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:${businessId}`}, 0))::text`;
        const actor = await db.user.findUniqueOrThrow({
          where: { id: userId },
          select: { id: true, name: true },
        });
        return fn(db, actor, access.member.business.name);
      },
      { maxWait: 15000, timeout: 30000 },
    );
  }
  private async product(db: Db, businessId: string, id: string) {
    const product = await db.inventoryProduct.findUnique({
      where: { businessId_id: { businessId, id } },
      include: PRODUCT_INCLUDE,
    });
    if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return product;
  }
  private async category(db: Db, businessId: string, id: string) {
    const category = await db.inventoryCategory.findUnique({
      where: { businessId_id: { businessId, id } },
    });
    if (!category)
      fail(
        400,
        'CATEGORY_REQUIRED',
        'Choose an existing category in this business',
        { categoryId: 'Category does not exist in this business' },
      );
    return category;
  }
  private async audit(
    db: Db,
    businessId: string,
    actor: { id: string; name: string },
    data: Omit<
      Prisma.InventoryMovementUncheckedCreateInput,
      'businessId' | 'actorId' | 'actorName'
    >,
  ) {
    return db.inventoryMovement.create({
      data: { businessId, actorId: actor.id, actorName: actor.name, ...data },
    });
  }
  private async shortage(db: Db, product: InventoryProduct, now: Date) {
    const classification = stockStatus(
      product.availableQuantity,
      product.lowStockThreshold,
    );
    const open = await db.inventoryShortage.findFirst({
      where: {
        businessId: product.businessId,
        productId: product.id,
        endedAt: null,
      },
    });
    if (
      open &&
      (classification === 'in_stock' ||
        open.classification !== classification ||
        open.threshold !== product.lowStockThreshold)
    ) {
      await db.inventoryShortage.update({
        where: { id: open.id },
        data: { endedAt: now },
      });
    }
    if (classification !== 'in_stock') {
      if (
        open &&
        open.classification === classification &&
        open.threshold === product.lowStockThreshold
      ) {
        await db.inventoryShortage.update({
          where: { id: open.id },
          data: {
            minimumStock: Math.min(
              open.minimumStock,
              product.availableQuantity,
            ),
          },
        });
      } else {
        await db.inventoryShortage.create({
          data: {
            businessId: product.businessId,
            productId: product.id,
            classification,
            threshold: product.lowStockThreshold,
            minimumStock: product.availableQuantity,
            startedAt: now,
          },
        });
      }
    }
  }
  private movement(before: InventoryProduct | null, after: InventoryProduct) {
    return {
      productId: after.id,
      categoryId: after.categoryId,
      quantityDelta: after.availableQuantity - (before?.availableQuantity ?? 0),
      quantityBefore: before?.availableQuantity ?? 0,
      quantityAfter: after.availableQuantity,
      purchaseCostBeforeMinor: before?.purchaseCostMinor ?? null,
      purchaseCostAfterMinor: after.purchaseCostMinor,
      sellingPriceBeforeMinor: before?.sellingPriceMinor ?? null,
      sellingPriceAfterMinor: after.sellingPriceMinor,
      thresholdBefore: before?.lowStockThreshold ?? null,
      thresholdAfter: after.lowStockThreshold,
      priceChanged:
        !!before &&
        (before.purchaseCostMinor !== after.purchaseCostMinor ||
          before.sellingPriceMinor !== after.sellingPriceMinor),
    };
  }
  private async idempotent<T>(
    db: Db,
    businessId: string,
    userId: string,
    key: string | undefined,
    scope: string,
    input: unknown,
    execute: () => Promise<T>,
  ) {
    if (!key || !/^[A-Za-z0-9_-]{16,80}$/.test(key))
      fail(
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Supply an Idempotency-Key with 16–80 letters, digits, underscores or hyphens',
      );
    const requestHash = hash(input);
    const previous = await db.inventoryOperation.findUnique({
      where: { businessId_key: { businessId, key } },
    });
    if (previous) {
      if (
        previous.userId !== userId ||
        previous.scope !== scope ||
        previous.requestHash !== requestHash
      )
        fail(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This key was used for a different request',
        );
      return previous.result as unknown as import('./inventory.helpers').Jsonified<T>;
    }
    const result = json(await execute());
    await db.inventoryOperation.create({
      data: {
        businessId,
        userId,
        key,
        scope,
        requestHash,
        result: result as Prisma.InputJsonValue,
      },
    });
    return result;
  }
  async summary(userId: string, businessId: string, categoryId?: string) {
    const access = await this.access.require(userId, businessId, [
      'inventory:view',
    ]);
    if (categoryId) await this.category(this.prisma, businessId, categoryId);
    const filter = categoryId
      ? Prisma.sql`AND "categoryId" = ${categoryId}`
      : Prisma.empty;
    const [counts] = await this.prisma.$queryRaw<
      {
        productCount: number;
        units: bigint;
        stockCostValueMinor: Prisma.Decimal;
        outOfStockCount: number;
        lowStockCount: number;
      }[]
    >`SELECT COUNT(*)::int AS "productCount", COALESCE(SUM("availableQuantity"),0) AS "units", COALESCE(SUM("availableQuantity" * "purchaseCostMinor"::numeric),0) AS "stockCostValueMinor", COUNT(*) FILTER (WHERE "availableQuantity" = 0)::int AS "outOfStockCount", COUNT(*) FILTER (WHERE "availableQuantity" > 0 AND "availableQuantity" <= "lowStockThreshold")::int AS "lowStockCount" FROM "InventoryProduct" WHERE "businessId" = ${businessId} ${filter}`;
    const categoryCount = await this.prisma.inventoryCategory.count({
      where: { businessId, ...(categoryId ? { id: categoryId } : {}) },
    });
    return {
      ...counts,
      units: money(Number(counts.units)),
      stockCostValueMinor: money(Number(counts.stockCostValueMinor)),
      categoryCount,
      currency: 'NGN',
      empty: counts.productCount === 0,
      needsFirstCategory: categoryCount === 0,
      access: {
        canManageCatalogue: access.permissions.includes('inventory:manage'),
        canReceive: access.permissions.includes('inventory:receive'),
        canCheckout: access.permissions.includes('inventory:checkout'),
        canReport: access.permissions.includes('inventory:report'),
      },
    };
  }
  async categories(userId: string, businessId: string, query: PageQuery) {
    await this.access.require(userId, businessId, ['inventory:view']);
    const where = {
      businessId,
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const page = pagination(query, where, 'nameKey', 'asc');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryCategory.findMany({
        ...(page.args as Prisma.InventoryCategoryFindManyArgs),
        include: {
          products: {
            select: { availableQuantity: true, purchaseCostMinor: true },
          },
        },
      }),
      this.prisma.inventoryCategory.count({ where }),
    ]);
    return page.finish(rows, total, (row) => {
      const { products, nameKey: _, ...category } = row;
      void _;
      return json({
        ...category,
        productCount: products.length,
        units: products.reduce((sum, p) => sum + p.availableQuantity, 0),
        stockCostValueMinor: money(
          products.reduce(
            (sum, p) => sum + p.availableQuantity * Number(p.purchaseCostMinor),
            0,
          ),
        ),
      });
    });
  }
  createCategory(userId: string, businessId: string, input: CategoryDto) {
    return this.mutate(
      userId,
      businessId,
      'inventory:manage',
      async (db, actor) => {
        const category = await db.inventoryCategory.create({
          data: { businessId, ...input, nameKey: input.name.toLowerCase() },
        });
        await this.audit(db, businessId, actor, {
          action: 'category',
          categoryId: category.id,
          summary: `Created category ${category.name}`,
          changes: json({
            name: { before: null, after: category.name },
            description: { before: null, after: category.description },
          }),
        });
        const { nameKey: _, ...safe } = category;
        void _;
        return {
          category: {
            ...safe,
            productCount: 0,
            units: 0,
            stockCostValueMinor: 0,
          },
          revision: category.revision,
        };
      },
    );
  }
  editCategory(
    userId: string,
    businessId: string,
    id: string,
    input: CategoryPatchDto,
    expected: number,
  ) {
    return this.mutate(
      userId,
      businessId,
      'inventory:manage',
      async (db, actor) => {
        const before = await db.inventoryCategory.findUnique({
          where: { businessId_id: { businessId, id } },
        });
        if (!before) fail(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        checkRevision(before.revision, expected);
        if (input.name === undefined && input.description === undefined)
          fail(400, 'EMPTY_EDIT', 'Supply a category field to edit');
        const category = await db.inventoryCategory.update({
          where: { id },
          data: {
            name: input.name,
            nameKey: input.name?.toLowerCase(),
            description: input.description,
            revision: { increment: 1 },
          },
        });
        await this.audit(db, businessId, actor, {
          action: 'category',
          categoryId: id,
          summary: `Updated category ${category.name}`,
          changes: json({
            name: { before: before.name, after: category.name },
            description: {
              before: before.description,
              after: category.description,
            },
          }),
        });
        const products = await db.inventoryProduct.findMany({
          where: { businessId, categoryId: id },
          select: { availableQuantity: true, purchaseCostMinor: true },
        });
        const { nameKey: _, ...safe } = category;
        void _;
        return {
          category: {
            ...safe,
            productCount: products.length,
            units: products.reduce((sum, p) => sum + p.availableQuantity, 0),
            stockCostValueMinor: money(
              products.reduce(
                (sum, p) =>
                  sum + p.availableQuantity * Number(p.purchaseCostMinor),
                0,
              ),
            ),
          },
          revision: category.revision,
        };
      },
    );
  }
  deleteCategory(
    userId: string,
    businessId: string,
    id: string,
    expected: number,
  ) {
    return this.mutate(
      userId,
      businessId,
      'inventory:manage',
      async (db, actor) => {
        const category = await db.inventoryCategory.findUnique({
          where: { businessId_id: { businessId, id } },
        });
        if (!category) fail(404, 'CATEGORY_NOT_FOUND', 'Category not found');
        checkRevision(category.revision, expected);
        if (
          await db.inventoryProduct.count({
            where: { businessId, categoryId: id },
          })
        )
          fail(
            409,
            'CATEGORY_NOT_EMPTY',
            'Move all products before deleting this category',
          );
        await this.audit(db, businessId, actor, {
          action: 'category',
          categoryId: id,
          summary: `Deleted category ${category.name}`,
          changes: { name: { before: category.name, after: null } },
        });
        await db.inventoryCategory.delete({ where: { id } });
      },
    );
  }
  async products(userId: string, businessId: string, query: InventoryQuery) {
    await this.access.require(userId, businessId, ['inventory:view']);
    const where: Prisma.InventoryProductWhereInput = {
      businessId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: ['name', 'barcode', 'sku'].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
      ...(query.stockStatus === 'out_of_stock'
        ? { availableQuantity: 0 }
        : query.stockStatus === 'low_stock'
          ? {
              AND: [
                { availableQuantity: { gt: 0 } },
                {
                  availableQuantity: {
                    lte: this.prisma.inventoryProduct.fields.lowStockThreshold,
                  },
                },
              ],
            }
          : query.stockStatus === 'in_stock'
            ? {
                availableQuantity: {
                  gt: this.prisma.inventoryProduct.fields.lowStockThreshold,
                },
              }
            : {}),
    };
    const [field, direction] = (query.sort ?? 'name_asc').split('_');
    if (
      !['name', 'createdAt', 'sellingPriceMinor', 'availableQuantity'].includes(
        field,
      )
    )
      fail(400, 'INVALID_SORT', 'Unsupported product sort');
    const page = pagination(query, where, field, direction as 'asc' | 'desc');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryProduct.findMany({
        ...(page.args as Prisma.InventoryProductFindManyArgs),
        include: PRODUCT_INCLUDE,
      }),
      this.prisma.inventoryProduct.count({ where }),
    ]);
    return page.finish(rows, total, productResponse);
  }
  async getProduct(userId: string, businessId: string, id: string) {
    await this.access.require(userId, businessId, ['inventory:view']);
    return {
      product: productResponse(await this.product(this.prisma, businessId, id)),
    };
  }
  async barcode(userId: string, businessId: string, barcode: string) {
    await this.access.require(userId, businessId, ['inventory:view']);
    if (!barcode || barcode.length > 100)
      fail(
        400,
        'INVALID_BARCODE',
        'Supply a barcode string of at most 100 characters',
      );
    const product = await this.prisma.inventoryProduct.findUnique({
      where: { businessId_barcode: { businessId, barcode } },
      include: PRODUCT_INCLUDE,
    });
    if (!product)
      fail(404, 'BARCODE_NOT_FOUND', 'No product matches this barcode');
    return { product: productResponse(product) };
  }
  createProduct(userId: string, businessId: string, input: ProductDto) {
    return this.mutate(
      userId,
      businessId,
      'inventory:manage',
      async (db, actor) => {
        await this.category(db, businessId, input.categoryId);
        money(input.openingUnits * input.purchaseCostMinor);
        const { openingUnits, ...details } = input;
        const product = await db.inventoryProduct.create({
          data: { businessId, ...details, availableQuantity: openingUnits },
          include: PRODUCT_INCLUDE,
        });
        const movement = await this.audit(db, businessId, actor, {
          ...this.movement(null, product),
          action: 'opening',
          summary: `Created ${product.name} with ${openingUnits} opening units`,
          changes: json(details),
          occurredAt: product.createdAt,
        });
        await this.shortage(db, product, product.createdAt);
        return {
          product: productResponse(product),
          revision: product.revision,
          balances: [
            {
              productId: product.id,
              availableQuantity: product.availableQuantity,
              revision: product.revision,
            },
          ],
          movementIds: [movement.id],
        };
      },
    );
  }
  editProduct(
    userId: string,
    businessId: string,
    id: string,
    input: ProductPatchDto,
    expected: number,
  ) {
    return this.mutate(
      userId,
      businessId,
      'inventory:manage',
      async (db, actor) => {
        const before = await this.product(db, businessId, id);
        checkRevision(before.revision, expected);
        const { expectedRevision: _, reason, ...fields } = input;
        void _;
        const changes = Object.fromEntries(
          Object.entries(fields)
            .filter(
              ([key, value]) =>
                value !== undefined &&
                JSON.stringify(json(value)) !==
                  JSON.stringify(json(before[key as keyof typeof before])),
            )
            .map(([key, value]) => [
              key,
              {
                before: json(before[key as keyof typeof before]),
                after: value,
              },
            ]),
        );
        if (!Object.keys(changes).length)
          return {
            product: productResponse(before),
            revision: before.revision,
            movementIds: [],
          };
        if (fields.categoryId)
          await this.category(db, businessId, fields.categoryId);
        if (fields.purchaseCostMinor !== undefined)
          money(before.availableQuantity * fields.purchaseCostMinor);
        const product = await db.inventoryProduct.update({
          where: { id },
          data: { ...fields, revision: { increment: 1 } },
          include: PRODUCT_INCLUDE,
        });
        const movement = await this.audit(db, businessId, actor, {
          ...this.movement(before, product),
          action: 'edit',
          summary: `Updated ${product.name}`,
          note: reason,
          changes: json(changes),
          occurredAt: product.updatedAt,
        });
        await this.shortage(db, product, product.updatedAt);
        return {
          product: productResponse(product),
          revision: product.revision,
          movementIds: [movement.id],
        };
      },
    );
  }
  receive(
    userId: string,
    businessId: string,
    productId: string,
    input: ReceiptDto,
    key?: string,
  ) {
    return this.mutate(userId, businessId, 'inventory:receive', (db, actor) =>
      this.idempotent(
        db,
        businessId,
        userId,
        key,
        `receive:${productId}`,
        input,
        async () => {
          const before = await this.product(db, businessId, productId);
          if (before.availableQuantity + input.quantity > 1000000)
            fail(
              400,
              'QUANTITY_OUT_OF_RANGE',
              'Balance cannot exceed 1,000,000 units',
            );
          money(
            (before.availableQuantity + input.quantity) *
              input.purchaseCostMinor,
          );
          const receipt = await db.inventoryReceipt.create({
            data: { businessId, productId, actorId: actor.id, ...input },
          });
          const product = await db.inventoryProduct.update({
            where: { id: productId },
            data: {
              availableQuantity: { increment: input.quantity },
              purchaseCostMinor: input.purchaseCostMinor,
              revision: { increment: 1 },
            },
            include: PRODUCT_INCLUDE,
          });
          const movement = await this.audit(db, businessId, actor, {
            ...this.movement(before, product),
            action: 'receive',
            summary: `Received ${input.quantity} units of ${product.name}`,
            receiptId: receipt.id,
            reference: input.reference,
            note: input.note,
            changes: json({
              supplier: input.supplier ?? null,
              purchaseCostMinor: {
                before: before.purchaseCostMinor,
                after: product.purchaseCostMinor,
              },
            }),
            occurredAt: product.updatedAt,
          });
          await this.shortage(db, product, product.updatedAt);
          return {
            receipt,
            product: productResponse(product),
            revision: product.revision,
            balances: [
              {
                productId,
                availableQuantity: product.availableQuantity,
                revision: product.revision,
              },
            ],
            movementIds: [movement.id],
          };
        },
      ),
    );
  }
  async movements(
    userId: string,
    businessId: string,
    query: InventoryQuery,
    priceHistory = false,
  ) {
    await this.access.require(userId, businessId, ['inventory:view']);
    if (query.productId)
      await this.product(this.prisma, businessId, query.productId);
    const period = range(query);
    const where: Prisma.InventoryMovementWhereInput = {
      businessId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(priceHistory ? { priceChanged: true } : {}),
      occurredAt: period.filter,
      ...(query.search
        ? {
            OR: ['summary', 'actorName', 'reference', 'note'].map((field) => ({
              [field]: { contains: query.search, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    if (query.sort && !query.sort.startsWith('occurredAt_'))
      fail(400, 'INVALID_SORT', 'Use occurredAt_asc or occurredAt_desc');
    const page = pagination(
      query,
      where,
      'occurredAt',
      query.sort === 'occurredAt_asc' ? 'asc' : 'desc',
    );
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany(
        page.args as Prisma.InventoryMovementFindManyArgs,
      ),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return page.finish(rows, total);
  }
  async shortages(
    userId: string,
    businessId: string,
    productId: string,
    query: InventoryQuery,
  ) {
    await this.access.require(userId, businessId, ['inventory:view']);
    const product = await this.product(this.prisma, businessId, productId);
    const { from, to } = range(query);
    const where = {
      businessId,
      productId,
      ...(to ? { startedAt: { lt: to } } : {}),
      ...(from ? { OR: [{ endedAt: null }, { endedAt: { gt: from } }] } : {}),
    };
    const page = pagination(query, where, 'startedAt', 'desc');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryShortage.findMany(
        page.args as Prisma.InventoryShortageFindManyArgs,
      ),
      this.prisma.inventoryShortage.count({ where }),
    ]);
    return {
      ...page.finish(rows, total),
      historyStartsAt: product.createdAt,
      timezone: 'Africa/Lagos',
    };
  }
  private cleanLines(lines: CartLineDto[]) {
    if (new Set(lines.map((line) => line.productId)).size !== lines.length)
      fail(
        400,
        'DUPLICATE_PRODUCT',
        'Each product may appear only once in the cart',
      );
    return lines
      .map(({ productId, quantity }) => ({ productId, quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));
  }
  async cart(userId: string, businessId: string) {
    await this.access.require(userId, businessId, ['inventory:checkout']);
    return {
      cart: (await this.prisma.inventoryCart.findUnique({
        where: { businessId_userId: { businessId, userId } },
      })) ?? { businessId, userId, lines: [], revision: 0, updatedAt: null },
    };
  }
  saveCart(
    userId: string,
    businessId: string,
    input: CartDto,
    expected: number,
  ) {
    return this.mutate(userId, businessId, 'inventory:checkout', async (db) => {
      const lines = this.cleanLines(input.lines);
      const old = await db.inventoryCart.findUnique({
        where: { businessId_userId: { businessId, userId } },
      });
      checkRevision(old?.revision ?? 0, expected);
      const count = await db.inventoryProduct.count({
        where: { businessId, id: { in: lines.map((line) => line.productId) } },
      });
      if (count !== lines.length)
        fail(
          404,
          'PRODUCT_NOT_FOUND',
          'One or more cart products do not belong to this business',
        );
      const cart = await db.inventoryCart.upsert({
        where: { businessId_userId: { businessId, userId } },
        create: { businessId, userId, lines: json(lines) },
        update: { lines: json(lines), revision: { increment: 1 } },
      });
      return { cart, revision: cart.revision };
    });
  }
  private async snapshot(
    db: Db,
    businessId: string,
    input: CartLineDto[],
  ): Promise<SnapshotLine[]> {
    const lines = this.cleanLines(input);
    const products = await db.inventoryProduct.findMany({
      where: { businessId, id: { in: lines.map((line) => line.productId) } },
      include: PRODUCT_INCLUDE,
    });
    if (products.length !== lines.length)
      fail(
        404,
        'PRODUCT_NOT_FOUND',
        'One or more products do not belong to this business',
      );
    return lines.map((line) => {
      const product = products.find((p) => p.id === line.productId)!;
      const expected = input.find(
        (l) => l.productId === product.id,
      )?.expectedSellingPriceMinor;
      return {
        ...line,
        productName: product.name,
        categoryId: product.categoryId,
        categoryName: product.category.name,
        barcode: product.barcode,
        sku: product.sku,
        sellingPriceMinor: Number(product.sellingPriceMinor),
        purchaseCostMinor: Number(product.purchaseCostMinor),
        revision: product.revision,
        availableQuantity: product.availableQuantity,
        totalMinor: money(line.quantity * Number(product.sellingPriceMinor)),
        totalCostMinor: money(
          line.quantity * Number(product.purchaseCostMinor),
        ),
        priceChanged:
          expected !== undefined &&
          expected !== Number(product.sellingPriceMinor),
        sufficientStock: product.availableQuantity >= line.quantity,
      };
    });
  }
  quote(userId: string, businessId: string, input: QuoteDto) {
    return this.mutate(userId, businessId, 'inventory:checkout', async (db) => {
      const lines = await this.snapshot(db, businessId, input.lines);
      const cart = await db.inventoryCart.findUnique({
        where: { businessId_userId: { businessId, userId } },
      });
      const totalMinor = money(
        lines.reduce((sum, line) => sum + line.totalMinor, 0),
      );
      const quote = await db.inventoryQuote.create({
        data: {
          businessId,
          userId,
          lines: json(lines),
          totalMinor,
          cartRevision: cart?.revision ?? 0,
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      return {
        quote: json({
          ...quote,
          currency: 'NGN',
          canComplete: lines.every((line) => line.sufficientStock),
          pricesChanged: lines.some((line) => line.priceChanged),
        }),
        revision: quote.revision,
      };
    });
  }
  completeSale(
    userId: string,
    businessId: string,
    input: SaleDto,
    key?: string,
  ) {
    return this.mutate(
      userId,
      businessId,
      'inventory:checkout',
      (db, actor, businessName) =>
        this.idempotent(
          db,
          businessId,
          userId,
          key,
          'sale',
          input,
          async () => {
            const quote = await db.inventoryQuote.findFirst({
              where: { id: input.quoteId, businessId, userId },
            });
            if (!quote) fail(404, 'QUOTE_NOT_FOUND', 'Quote not found');
            if (quote.usedAt || quote.expiresAt <= new Date())
              fail(409, 'QUOTE_EXPIRED', 'Request a fresh quote');
            checkRevision(quote.revision, input.quoteRevision);
            const quoted = quote.lines as unknown as SnapshotLine[];
            if (
              hash(this.cleanLines(input.lines)) !==
              hash(this.cleanLines(quoted))
            )
              fail(409, 'QUOTE_MISMATCH', 'Sale lines must match the quote');
            // Deterministic row locks also protect balances if a future writer no longer uses the business lock.
            const ids = quoted.map((line) => line.productId).sort();
            await db.$queryRaw(
              Prisma.sql`SELECT "id" FROM "InventoryProduct" WHERE "businessId" = ${businessId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`,
            );
            const fresh = await this.snapshot(db, businessId, input.lines);
            if (fresh.some((line) => !line.sufficientStock))
              fail(
                409,
                'INSUFFICIENT_STOCK',
                'One or more products no longer have enough stock',
              );
            if (
              fresh.some((line) => {
                const old = quoted.find((q) => q.productId === line.productId)!;
                return (
                  old.revision !== line.revision ||
                  old.sellingPriceMinor !== line.sellingPriceMinor ||
                  old.purchaseCostMinor !== line.purchaseCostMinor ||
                  old.categoryName !== line.categoryName
                );
              })
            )
              fail(
                409,
                'REVISION_CONFLICT',
                'Products changed; review a fresh quote before completing the sale',
              );
            const cart = await db.inventoryCart.findUnique({
              where: { businessId_userId: { businessId, userId } },
            });
            checkRevision(cart?.revision ?? 0, quote.cartRevision);
            const totalMinor = money(
              fresh.reduce((sum, line) => sum + line.totalMinor, 0),
            );
            const totalCostMinor = money(
              fresh.reduce((sum, line) => sum + line.totalCostMinor, 0),
            );
            if (
              input.paymentMethod === 'cash' &&
              (input.tenderMinor === undefined ||
                input.tenderMinor < totalMinor)
            )
              fail(
                400,
                'INSUFFICIENT_TENDER',
                'Cash tender must cover the sale total',
              );
            if (
              input.paymentMethod !== 'cash' &&
              input.paymentConfirmed !== true
            )
              fail(
                409,
                'PAYMENT_NOT_CONFIRMED',
                'Confirm the transfer or card payment manually',
              );
            const sale = await db.inventorySale.create({
              data: {
                businessId,
                number: `BP-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().replaceAll('-', '').toUpperCase()}`,
                businessName,
                actorId: actor.id,
                actorName: actor.name,
                paymentMethod: input.paymentMethod,
                paymentStatus:
                  input.paymentMethod === 'cash'
                    ? 'cash_received'
                    : 'manually_confirmed',
                customerName: input.customerName,
                customerContact: input.customerContact,
                totalMinor,
                totalCostMinor,
                tenderMinor:
                  input.paymentMethod === 'cash' ? input.tenderMinor : null,
                changeMinor:
                  input.paymentMethod === 'cash'
                    ? input.tenderMinor! - totalMinor
                    : 0,
                units: fresh.reduce((sum, line) => sum + line.quantity, 0),
                lines: {
                  create: fresh.map(
                    ({
                      revision: _,
                      availableQuantity: _q,
                      priceChanged: _p,
                      sufficientStock: _s,
                      ...line
                    }) => {
                      void _;
                      void _q;
                      void _p;
                      void _s;
                      return line;
                    },
                  ),
                },
              },
              include: { lines: true },
            });
            const balances: {
              productId: string;
              availableQuantity: number;
              revision: number;
            }[] = [];
            const movementIds: string[] = [];
            for (const line of fresh) {
              const before = await this.product(db, businessId, line.productId);
              const after = await db.inventoryProduct.update({
                where: { id: line.productId },
                data: {
                  availableQuantity: { decrement: line.quantity },
                  revision: { increment: 1 },
                },
              });
              const movement = await this.audit(db, businessId, actor, {
                ...this.movement(before, after),
                action: 'sale',
                saleId: sale.id,
                summary: `Sold ${line.quantity} units of ${line.productName}`,
                reference: sale.number,
                changes: {
                  quantity: {
                    before: before.availableQuantity,
                    after: after.availableQuantity,
                  },
                },
                occurredAt: sale.occurredAt,
              });
              await this.shortage(db, after, sale.occurredAt);
              balances.push({
                productId: after.id,
                availableQuantity: after.availableQuantity,
                revision: after.revision,
              });
              movementIds.push(movement.id);
            }
            await db.inventoryQuote.update({
              where: { id: quote.id },
              data: { usedAt: sale.occurredAt },
            });
            const clearedCart = await db.inventoryCart.upsert({
              where: { businessId_userId: { businessId, userId } },
              create: { businessId, userId, lines: [] },
              update: { lines: [], revision: { increment: 1 } },
            });
            return {
              sale: json(sale),
              revision: sale.revision,
              balances,
              movementIds,
              cart: clearedCart,
            };
          },
        ),
    );
  }
  async sales(userId: string, businessId: string, query: InventoryQuery) {
    await this.access.require(userId, businessId, ['inventory:sales:view']);
    const period = range(query);
    const where: Prisma.InventorySaleWhereInput = {
      businessId,
      occurredAt: period.filter,
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
      ...(query.search
        ? {
            OR: [
              { number: { contains: query.search, mode: 'insensitive' } },
              { customerName: { contains: query.search, mode: 'insensitive' } },
              { actorName: { contains: query.search, mode: 'insensitive' } },
              {
                lines: {
                  some: {
                    productName: {
                      contains: query.search,
                      mode: 'insensitive',
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };
    if (query.sort && !query.sort.startsWith('occurredAt_'))
      fail(400, 'INVALID_SORT', 'Use occurredAt_asc or occurredAt_desc');
    const page = pagination(
      query,
      where,
      'occurredAt',
      query.sort === 'occurredAt_asc' ? 'asc' : 'desc',
    );
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventorySale.findMany(
        page.args as Prisma.InventorySaleFindManyArgs,
      ),
      this.prisma.inventorySale.count({ where }),
    ]);
    return page.finish(rows, total);
  }
  async sale(userId: string, businessId: string, id: string) {
    await this.access.require(userId, businessId, ['inventory:sales:view']);
    const sale = await this.prisma.inventorySale.findUnique({
      where: { businessId_id: { businessId, id } },
      include: { lines: true },
    });
    if (!sale) fail(404, 'SALE_NOT_FOUND', 'Sale not found');
    return { sale: json(sale) };
  }
  async analytics(userId: string, businessId: string, query: InventoryQuery) {
    await this.access.require(userId, businessId, ['inventory:report']);
    const period = range(query, true);
    if (
      !period.from ||
      !period.to ||
      period.to.getTime() - period.from.getTime() > 366 * 86400000
    )
      fail(
        400,
        'INVALID_PERIOD',
        'Analytics requires a from/to pair spanning at most 366 days',
      );
    const lines = await this.prisma.inventorySaleLine.findMany({
      where: {
        businessId,
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        sale: { occurredAt: period.filter },
      },
      include: { sale: { select: { id: true, occurredAt: true } } },
    });
    const day = (date: Date) =>
      new Date(date.getTime() + 3600000).toISOString().slice(0, 10);
    const timeline = new Map<
      string,
      {
        date: string;
        revenueMinor: number;
        grossProfitMinor: number;
        units: number;
        saleIds: Set<string>;
      }
    >();
    const firstDay = new Date(`${day(period.from)}T00:00:00+01:00`);
    for (
      let current = firstDay.getTime();
      current < period.to.getTime();
      current += 86400000
    ) {
      const date = day(new Date(current));
      timeline.set(date, {
        date,
        revenueMinor: 0,
        grossProfitMinor: 0,
        units: 0,
        saleIds: new Set(),
      });
    }
    const products = new Map<
      string,
      {
        productId: string;
        name: string;
        units: number;
        revenueMinor: number;
        grossProfitMinor: number;
      }
    >();
    const categories = new Map<
      string,
      { categoryId: string; name: string; revenueMinor: number; units: number }
    >();
    const saleIds = new Set<string>();
    let revenueMinor = 0;
    let totalCostMinor = 0;
    let units = 0;
    for (const line of lines) {
      const revenue = Number(line.totalMinor);
      const cost = Number(line.totalCostMinor);
      revenueMinor = money(revenueMinor + revenue);
      totalCostMinor = money(totalCostMinor + cost);
      units += line.quantity;
      saleIds.add(line.sale.id);
      const point = timeline.get(day(line.sale.occurredAt))!;
      point.revenueMinor = money(point.revenueMinor + revenue);
      point.grossProfitMinor += revenue - cost;
      point.units += line.quantity;
      point.saleIds.add(line.sale.id);
      const product = products.get(line.productId) ?? {
        productId: line.productId,
        name: line.productName,
        units: 0,
        revenueMinor: 0,
        grossProfitMinor: 0,
      };
      product.units += line.quantity;
      product.revenueMinor = money(product.revenueMinor + revenue);
      product.grossProfitMinor += revenue - cost;
      products.set(line.productId, product);
      const category = categories.get(line.categoryId) ?? {
        categoryId: line.categoryId,
        name: line.categoryName,
        revenueMinor: 0,
        units: 0,
      };
      category.revenueMinor = money(category.revenueMinor + revenue);
      category.units += line.quantity;
      categories.set(line.categoryId, category);
    }
    const restock = await this.prisma.inventoryProduct.findMany({
      where: {
        businessId,
        ...(query.productId ? { id: query.productId } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        availableQuantity: {
          lte: this.prisma.inventoryProduct.fields.lowStockThreshold,
        },
      },
      include: PRODUCT_INCLUDE,
      orderBy: [{ availableQuantity: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    return {
      currency: 'NGN',
      timezone: 'Africa/Lagos',
      from: period.from,
      to: period.to,
      revenueMinor,
      totalCostMinor,
      grossProfitMinor: revenueMinor - totalCostMinor,
      saleCount: saleIds.size,
      units,
      averageSaleMinor: saleIds.size
        ? Math.round(revenueMinor / saleIds.size)
        : 0,
      daily: [...timeline.values()].map(({ saleIds, ...point }) => ({
        ...point,
        saleCount: saleIds.size,
      })),
      topProducts: [...products.values()].sort(
        (a, b) => b.units - a.units || a.productId.localeCompare(b.productId),
      ),
      categoryRevenue: [...categories.values()].sort(
        (a, b) =>
          b.revenueMinor - a.revenueMinor ||
          a.categoryId.localeCompare(b.categoryId),
      ),
      restock: restock.map(productResponse),
      restockLimit: 100,
    };
  }
}
