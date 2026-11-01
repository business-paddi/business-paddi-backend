import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/access/business-access.service';
import {
  CategoryDto,
  CategoryPatchDto,
  ProductDto,
  ProductPatchDto,
  InventoryQuery,
  PageQuery,
} from './inventory.dto';
import {
  checkRevision,
  fail,
  json,
  money,
  pagination,
  productResponse,
} from './inventory.helpers';
import { InventoryContext, PRODUCT_INCLUDE } from './inventory-context';

@Injectable()
export class InventoryCatalogService extends InventoryContext {
  constructor(prisma: PrismaService, access: BusinessAccessService) {
    super(prisma, access);
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
}
