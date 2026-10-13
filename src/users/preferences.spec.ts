import { UsersService } from './users.service';
import type { PrismaService } from '../database/prisma.service';
import { toPublicPreferences } from '../onboarding/onboarding-preferences';
type Dependencies = ConstructorParameters<typeof UsersService>;
describe('Sidebar preference', () => {
  it('updates the display setting without security reauthentication and preserves unrelated fields', async () => {
    const db = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          passwordHash: null,
          preferences: { twoFactorEnabled: true },
        }),
      },
      userPreference: {
        upsert: jest.fn().mockResolvedValue({
          sidebarMinimized: true,
          desktopNotifications: false,
          twoFactorEnabled: true,
        }),
      },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(
      (fn: (transaction: typeof db) => unknown) => fn(db),
    );
    const audit = { record: jest.fn() };
    const sensitive = { consumeAuthorization: jest.fn() };
    const service = new UsersService(
      db as unknown as PrismaService,
      audit as unknown as Dependencies[1],
      {} as Dependencies[2],
      {} as Dependencies[3],
      {} as Dependencies[4],
      sensitive as unknown as Dependencies[5],
    );
    const result = await service.updatePreferences(
      'u',
      's',
      { sidebarMinimized: true },
      {} as Parameters<UsersService['updatePreferences']>[3],
    );
    expect(result.sidebarMinimized).toBe(true);
    expect(result.twoFactorEnabled).toBe(true);
    expect(result.desktopNotifications).toBe(false);
    const calls = db.userPreference.upsert.mock.calls as unknown[][];
    const upsert = calls[0][0] as {
      update: unknown;
    };
    expect(upsert.update).toEqual({
      sidebarMinimized: true,
      desktopNotifications: undefined,
      twoFactorEnabled: undefined,
    });
    expect(sensitive.consumeAuthorization).not.toHaveBeenCalled();
  });
  it('defaults sidebarMinimized to false for existing users', () => {
    expect(toPublicPreferences(null).sidebarMinimized).toBe(false);
  });
});
