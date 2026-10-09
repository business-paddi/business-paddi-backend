import { randomBytes } from 'node:crypto';
import {
  allowedPermissions,
  effectivePermissions,
  systemRolePermissions,
} from './permission-catalog';
import {
  decryptPayrollField,
  EMPLOYEE_PUBLIC_SELECT,
  encryptPayrollField,
} from './sensitive-fields';

describe('Business foundation', () => {
  it('preserves the exact supplied catalog and role grant counts', () => {
    expect(new Set(allowedPermissions).size).toBe(42);
    expect(
      Object.fromEntries(
        Object.entries(systemRolePermissions).map(([key, grants]) => [
          key,
          grants.length,
        ]),
      ),
    ).toEqual({
      owner: 42,
      admin: 23,
      finance_manager: 15,
      accountant: 6,
      employee: 4,
      contributor: 3,
      viewer: 4,
    });
    for (const grants of Object.values(systemRolePermissions)) {
      expect(new Set(grants).size).toBe(grants.length);
      expect(grants.every((grant) => allowedPermissions.includes(grant))).toBe(
        true,
      );
    }
    expect(systemRolePermissions.admin).not.toContain('business:update');
    expect(systemRolePermissions.admin).not.toContain('members:update_role');
  });

  it('denials override grants', () => {
    expect(
      effectivePermissions(
        ['employees:view', 'employees:update'],
        ['employees:update'],
      ),
    ).toEqual(['employees:view']);
  });

  it('encrypts sensitive strings, preserves leading zeroes, and authenticates ciphertext', () => {
    const key = randomBytes(32).toString('base64');
    const encrypted = encryptPayrollField('0012345678', key);
    expect(encrypted).not.toContain('0012345678');
    expect(decryptPayrollField(encrypted, key)).toBe('0012345678');
    expect(encryptPayrollField('0012345678', key)).not.toBe(encrypted);
    expect(() =>
      decryptPayrollField(encrypted, randomBytes(32).toString('base64')),
    ).toThrow();
    const tampered =
      encrypted.slice(0, -1) + (encrypted.endsWith('0') ? '1' : '0');
    expect(() => decryptPayrollField(tampered, key)).toThrow();
    expect(() => encryptPayrollField('x', 'short')).toThrow();
  });

  it('excludes bank and tax identifiers from ordinary employee selections', () => {
    for (const key of [
      'accountNumber',
      'accountName',
      'taxProfile',
      'pensionAccountNumber',
      'taxIdentificationNumber',
    ]) {
      expect(EMPLOYEE_PUBLIC_SELECT).not.toHaveProperty(key);
    }
  });
});
