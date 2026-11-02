import { verify } from 'argon2';
import { AuthService } from './auth.service';
import type { RequestLocationContext } from '../../location/location.service';

describe('registration ownership', () => {
  it('activates only the credential belonging to the verifying browser and code', async () => {
    const pending = new Map<string, { name: string; passwordHash: string }>();
    const otp = new Map<string, string>();
    const row = {
      id: 'legacy',
      emailVerifiedAt: null,
      passwordHash: 'legacy-hash',
    };
    const db = {
      $queryRaw: jest.fn(),
      user: {
        findUnique: () => row,
        updateMany: ({ data }: { data: { passwordHash: string } }) => {
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    };
    const codes = {
      admit: jest.fn(),
      savePending: (key: string, name: string, passwordHash: string) =>
        pending.set(key, { name, passwordHash }),
      pending: (key: string) => pending.get(key),
      issueEmailCode: (key: string) => {
        const code = String(100000 + otp.size);
        otp.set(key, code);
        return { code, deliveryId: key };
      },
      consumeEmailCode: (key: string, code: string) =>
        otp.get(key) === code ? 'verified' : 'invalid',
    };
    const auth = Object.assign(Object.create(AuthService.prototype) as object, {
      prisma: {
        ...db,
        $transaction: (work: (tx: typeof db) => unknown) => work(db),
      },
      verificationCodes: codes,
      audit: { record: jest.fn(), recordBestEffort: jest.fn() },
      emailService: { sendEmailVerification: jest.fn() },
    }) as unknown as AuthService;
    const ctx = {
      requestMetadata: { ipAddress: '127.0.0.1' },
    } as RequestLocationContext;
    const email = 'owner@example.test';
    const first = await auth.registerUser(
      { email, name: 'First', password: 'first-password' },
      ctx,
    );
    const owner = await auth.registerUser(
      { email, name: 'Owner', password: 'owner-password' },
      ctx,
    );
    expect(row.passwordHash).toBe('legacy-hash');
    await expect(
      auth.verifyEmail({ email, code: '100001' }, ctx, first.attempt),
    ).rejects.toThrow();
    await auth.verifyEmail({ email, code: '100001' }, ctx, owner.attempt);
    expect(await verify(row.passwordHash, 'first-password')).toBe(false);
    expect(await verify(row.passwordHash, 'owner-password')).toBe(true);
    await expect(
      auth.verifyEmail({ email, code: '100000' }, ctx, first.attempt),
    ).rejects.toThrow();
  });
});
