import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const digest = (v: unknown) =>
  createHash('sha256').update(canonical(v)).digest('hex');
export function conflict(
  code: string,
  task?: { revision: number; status: string },
): never {
  throw new ConflictException({
    code,
    message: code,
    ...(task ? { revision: task.revision, status: task.status } : {}),
  });
}
export function encodeCursor(
  secret: string,
  filter: unknown,
  position: unknown,
) {
  const payload = Buffer.from(
    JSON.stringify({ filter: digest(filter), position }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function decodeCursor<T>(
  secret: string,
  filter: unknown,
  cursor?: string,
): T | undefined {
  if (!cursor) return;
  try {
    const [p, s, ...rest] = cursor.split('.');
    const expected = createHmac('sha256', secret).update(p).digest();
    const actual = Buffer.from(s, 'base64url');
    if (
      rest.length ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Error();
    const parsed = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      filter: string;
      position: T;
    };
    if (parsed.filter !== digest(filter)) throw new Error();
    return parsed.position;
  } catch {
    throw new BadRequestException({
      code: 'INVALID_CURSOR',
      message: 'Cursor does not match this request',
    });
  }
}
export const OPEN_STATUSES = [
  'unassigned',
  'todo',
  'in_progress',
  'in_review',
  'changes_requested',
];
