import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/access/business-access.service';
import { CartDto, QuoteDto, SaleDto, CartLineDto } from './inventory.dto';
import { checkRevision, fail, hash, json, money } from './inventory.helpers';
import { randomUUID } from 'node:crypto';
import {
  InventoryContext,
  PRODUCT_INCLUDE,
  type Db,
} from './inventory-context';

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
export class InventoryCheckoutService extends InventoryContext {
  constructor(prisma: PrismaService, access: BusinessAccessService) {
    super(prisma, access);
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
}
