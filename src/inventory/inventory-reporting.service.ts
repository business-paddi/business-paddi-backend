import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business/access/business-access.service';
import { InventoryQuery } from './inventory.dto';
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
export class InventoryReportingService extends InventoryContext {
  constructor(prisma: PrismaService, access: BusinessAccessService) {
    super(prisma, access);
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
