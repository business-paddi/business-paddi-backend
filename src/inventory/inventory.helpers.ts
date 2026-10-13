import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { InventoryProduct } from '../../generated/prisma/client';

export function fail(
  status: number,
  code: string,
  message: string,
  fields: Record<string, string> = {},
): never {
  throw new HttpException(
    { statusCode: status, code, message, fieldErrors: fields },
    status,
  );
}
export type Jsonified<T> = T extends bigint
  ? number
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? Jsonified<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonified<T[K]> }
        : T;
export function json<T>(value: T): Jsonified<T> {
  return JSON.parse(
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === 'bigint' ? Number(item) : item,
    ),
  ) as Jsonified<T>;
}
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}
export function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function money(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(
      400,
      'AMOUNT_OUT_OF_RANGE',
      'Amount exceeds the supported integer minor-unit range',
    );
  return value;
}
export function revision(body: number | undefined, header?: string): number {
  let match: number | undefined;
  if (header !== undefined) {
    if (!/^(?:"\d+"|\d+)$/.test(header))
      fail(
        400,
        'INVALID_REVISION',
        'If-Match must contain an integer revision',
      );
    match = Number(header.replaceAll('"', ''));
  }
  if (body !== undefined && match !== undefined && body !== match)
    fail(400, 'INVALID_REVISION', 'Body and If-Match revisions disagree');
  const result = body ?? match;
  if (result === undefined)
    fail(428, 'REVISION_REQUIRED', 'Supply expectedRevision or If-Match');
  if (!Number.isSafeInteger(result) || result < 0 || result > 2147483646)
    fail(400, 'INVALID_REVISION', 'Invalid revision');
  return result;
}
export function checkRevision(actual: number, expected: number) {
  if (actual !== expected)
    fail(409, 'REVISION_CONFLICT', 'The record changed; refresh before saving');
}
export function stockStatus(quantity: number, threshold: number) {
  return quantity === 0
    ? 'out_of_stock'
    : quantity <= threshold
      ? 'low_stock'
      : 'in_stock';
}
export function productResponse<
  T extends InventoryProduct & { category?: unknown },
>(product: T) {
  return json({
    ...product,
    currency: 'NGN',
    stockStatus: stockStatus(
      product.availableQuantity,
      product.lowStockThreshold,
    ),
  });
}
export function range(
  query: { from?: string; to?: string; period?: string },
  defaultPeriod = false,
) {
  const now = new Date();
  let from = query.from ? new Date(query.from) : undefined;
  let to = query.to ? new Date(query.to) : undefined;
  if (query.period && (from || to))
    fail(400, 'INVALID_PERIOD', 'Use period or from/to, not both');
  if (query.period || (defaultPeriod && !from && !to)) {
    const today = new Date(
      Math.floor((now.getTime() + 3_600_000) / 86_400_000) * 86_400_000 -
        3_600_000,
    );
    from = new Date(
      today.getTime() -
        ((query.period === 'today' ? 1 : query.period === '7d' ? 7 : 30) - 1) *
          86_400_000,
    );
    to = new Date(today.getTime() + 86_400_000);
  }
  if (
    (from && !Number.isFinite(from.getTime())) ||
    (to && !Number.isFinite(to.getTime())) ||
    (from && to && from >= to)
  )
    fail(400, 'INVALID_PERIOD', 'from must precede to');
  return {
    from,
    to,
    filter: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) },
  };
}
export function pagination(
  query: { cursor?: string; limit: number },
  where: object,
  field: string,
  direction: 'asc' | 'desc',
) {
  const fingerprint = hash(json({ where, field, direction }));
  let boundary: object = {};
  if (query.cursor) {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString(),
      );
      if (!parsed || typeof parsed !== 'object') throw new Error();
      const data = parsed as Record<string, unknown>;
      if (
        data.fingerprint !== fingerprint ||
        typeof data.id !== 'string' ||
        data.id.length > 128 ||
        (typeof data.value !== 'string' && typeof data.value !== 'number')
      )
        throw new Error();
      const value = field.endsWith('At')
        ? new Date(data.value)
        : field.endsWith('Minor')
          ? BigInt(data.value)
          : data.value;
      if (value instanceof Date && !Number.isFinite(value.getTime()))
        throw new Error();
      const comparison = direction === 'asc' ? 'gt' : 'lt';
      boundary = {
        OR: [
          { [field]: { [comparison]: value } },
          { [field]: value, id: { [comparison]: data.id } },
        ],
      };
    } catch {
      fail(
        400,
        'INVALID_CURSOR',
        'Cursor is invalid or does not match the filters/sort',
      );
    }
  }
  return {
    args: {
      where: { AND: [where, boundary] },
      orderBy: [{ [field]: direction }, { id: direction }],
      take: query.limit + 1,
    },
    finish<T extends { id: string }, R = Jsonified<T>>(
      rows: T[],
      total: number,
      map?: (row: T) => R,
    ) {
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((row) => (map ? map(row) : (json(row) as R))),
        total,
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(
                JSON.stringify(
                  json({
                    id: last.id,
                    value: last[field as keyof T],
                    fingerprint,
                  }),
                ),
              ).toString('base64url')
            : null,
      };
    },
  };
}
