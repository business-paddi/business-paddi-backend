import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/access/business-access.service';
import { InventoryQuery, ReceiptDto } from './inventory.dto';
import {
  fail,
  json,
  money,
  pagination,
  productResponse,
  range,
} from './inventory.helpers';
import { InventoryContext, PRODUCT_INCLUDE } from './inventory-context';

@Injectable()
export class InventoryStockService extends InventoryContext {
  constructor(prisma: PrismaService, access: BusinessAccessService) {
    super(prisma, access);
  }
  async operationStatus(
    userId: string,
    businessId: string,
    kind: string,
    key: string,
  ) {
    if (
      !['sale', 'receive'].includes(kind) ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(key)
    )
      fail(400, 'INVALID_OPERATION', 'Invalid transaction reference');
    await this.access.require(userId, businessId, [
      kind === 'sale' ? 'inventory:checkout' : 'inventory:receive',
    ]);
    const operation = await this.prisma.inventoryOperation.findFirst({
      where: {
        businessId,
        userId,
        key,
        scope: kind === 'sale' ? 'sale' : { startsWith: 'receive:' },
      },
      select: { key: true },
    });
    return { recorded: !!operation };
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
}
