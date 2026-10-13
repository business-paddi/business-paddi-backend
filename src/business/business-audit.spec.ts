import type { PrismaService } from '../database/prisma.service';
import type { BusinessAccessService } from './business-access.service';
import { BusinessAuditService } from './business-audit.service';

describe('Business audit scope and pagination', () => {
  const db = { auditEvent: { findFirst: jest.fn(), findMany: jest.fn() } };
  const access = { lock: jest.fn() };
  const service = new BusinessAuditService(
    {
      $transaction: async (fn: (db: unknown) => Promise<unknown>) => fn(db),
    } as unknown as PrismaService,
    access as unknown as BusinessAccessService,
  );
  beforeEach(() => jest.resetAllMocks());
  it('requires audit_logs:view and restricts all rows to the business', async () => {
    db.auditEvent.findMany.mockResolvedValue([
      { eventId: 'one' },
      { eventId: 'two' },
    ]);
    const result = await service.list('u', 'b', {
      limit: 1,
      eventType: 'business.invite.created',
    });
    expect(access.lock).toHaveBeenCalledWith('u', 'b', ['audit_logs:view'], db);
    expect(db.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: 'b', eventType: 'business.invite.created' },
      }),
    );
    expect(result.nextCursor).toBe('one');
    expect(result.items).toHaveLength(1);
  });
  it('does not accept a cursor from another tenant', async () => {
    db.auditEvent.findFirst.mockResolvedValue(null);
    await expect(
      service.list('u', 'b', { limit: 30, cursor: 'foreign' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.auditEvent.findMany).not.toHaveBeenCalled();
  });
});
