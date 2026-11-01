import { Prisma, type InventoryProduct } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/access/business-access.service';
import type { Permission } from '../business-foundation/permission-catalog';
import { fail, hash, json, stockStatus } from './inventory.helpers';

export const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
} as const;
export type Db = Prisma.TransactionClient;
export abstract class InventoryContext {
  constructor(
    protected readonly prisma: PrismaService,
    protected readonly access: BusinessAccessService,
  ) {}
  protected async mutate<T>(
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
  protected async product(db: Db, businessId: string, id: string) {
    const product = await db.inventoryProduct.findUnique({
      where: { businessId_id: { businessId, id } },
      include: PRODUCT_INCLUDE,
    });
    if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return product;
  }
  protected async category(db: Db, businessId: string, id: string) {
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
  protected async audit(
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
  protected async shortage(db: Db, product: InventoryProduct, now: Date) {
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
  protected movement(before: InventoryProduct | null, after: InventoryProduct) {
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
  protected async idempotent<T>(
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
}
