import 'dotenv/config';
import { databaseErrorSummary } from './database-error';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import {
  allowedPermissions,
  effectivePermissions,
  systemRolePermissions,
  type Permission,
  type SystemRoleKey,
} from '../src/business-foundation/permission-catalog';
import {
  seedEmployeeTypes,
  seedSystemRoles,
} from '../src/business-foundation/seed';
import { encryptPayrollField } from '../src/business-foundation/sensitive-fields';

class IntegrityRollback extends Error {}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 15000,
    }),
  });
  let checks = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        const check = (label: string, condition: unknown) => {
          assert.ok(condition, label);
          checks++;
          console.log(`PASS: ${label}`);
        };
        const rejected = async (
          label: string,
          operation: () => Promise<unknown>,
          expected: string,
        ) => {
          await tx.$executeRawUnsafe('SAVEPOINT integrity_case');
          let failure: unknown;
          try {
            await operation();
          } catch (error) {
            failure = error;
          }
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT integrity_case');
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT integrity_case');
          assert.ok(
            failure instanceof Error,
            `${label}: operation unexpectedly succeeded`,
          );
          const known = failure as Error & { code?: string };
          assert.ok(
            known.message.includes(expected) || known.code === expected,
            `${label}: failed for an unexpected reason: ${known.message}`,
          );
          checks++;
          console.log(`PASS: ${label}`);
        };
        await seedSystemRoles(tx);
        const before = await tx.rolePermission.count();
        await seedSystemRoles(tx);
        check(
          'permission seeds are idempotent',
          before === (await tx.rolePermission.count()),
        );
        check(
          'catalog contains exactly the supplied permissions',
          (await tx.permission.count()) === allowedPermissions.length,
        );
        for (const key of Object.keys(
          systemRolePermissions,
        ) as SystemRoleKey[]) {
          const role = await tx.role.findUniqueOrThrow({
            where: { id: `system-role-${key}` },
            include: { permissions: true, deniedPermissions: true },
          });
          assert.deepEqual(
            role.permissions.map((grant) => grant.permission).sort(),
            [...systemRolePermissions[key]].sort(),
          );
          check(
            `exact grants, empty denials, and global active scope for ${key}`,
            role.deniedPermissions.length === 0 &&
              role.businessId === null &&
              role.type === 'system' &&
              role.status === 'active',
          );
        }

        const suffix = randomUUID();
        const u1 = await tx.user.create({
          data: {
            email: `integrity-a-${suffix}@example.invalid`,
            name: 'Integrity A',
            preferences: { create: {} },
          },
        });
        const u2 = await tx.user.create({
          data: {
            email: `integrity-b-${suffix}@example.invalid`,
            name: 'Integrity B',
          },
        });
        const b1 = await tx.business.create({
          data: { name: `Integrity A ${suffix}` },
        });
        const b2 = await tx.business.create({
          data: { name: `Integrity B ${suffix}` },
        });
        await seedEmployeeTypes(tx, b1.id);
        await seedEmployeeTypes(tx, b2.id);
        const type1 = await tx.employeeType.findUniqueOrThrow({
          where: { businessId_key: { businessId: b1.id, key: 'full_time' } },
        });
        const type2 = await tx.employeeType.findUniqueOrThrow({
          where: { businessId_key: { businessId: b2.id, key: 'full_time' } },
        });
        const m1 = await tx.businessMember.create({
          data: {
            businessId: b1.id,
            userId: u1.id,
            roleId: 'system-role-viewer',
          },
        });
        const m2 = await tx.businessMember.create({
          data: {
            businessId: b2.id,
            userId: u1.id,
            roleId: 'system-role-viewer',
          },
        });
        await tx.businessMember.create({
          data: {
            businessId: b1.id,
            userId: u2.id,
            roleId: 'system-role-employee',
          },
        });
        check(
          'one user belongs to multiple businesses',
          (await tx.businessMember.count({ where: { userId: u1.id } })) === 2,
        );
        check(
          'one business has multiple independent platform members',
          (await tx.businessMember.count({ where: { businessId: b1.id } })) ===
            2,
        );
        check(
          'membership does not create employee records',
          (await tx.businessEmployee.count({
            where: { businessId: b1.id },
          })) === 0,
        );
        await rejected(
          'duplicate memberships are rejected',
          () =>
            tx.businessMember.create({
              data: {
                businessId: b1.id,
                userId: u1.id,
                roleId: 'system-role-viewer',
              },
            }),
          'P2002',
        );

        const e1 = await tx.businessEmployee.create({
          data: {
            businessId: b1.id,
            fullName: 'Unbanked Employee',
            email: `employee-a-${suffix}@example.invalid`,
            state: 'Lagos',
            employeeTypeId: type1.id,
            amount: new Prisma.Decimal('12345678901234.56'),
          },
        });
        const e2 = await tx.businessEmployee.create({
          data: {
            businessId: b2.id,
            fullName: 'Other Business Employee',
            email: `employee-b-${suffix}@example.invalid`,
            state: 'Lagos',
            employeeTypeId: type2.id,
            amount: 0,
          },
        });
        const e3 = await tx.businessEmployee.create({
          data: {
            businessId: b1.id,
            fullName: 'Linked Employee',
            email: `employee-c-${suffix}@example.invalid`,
            state: 'Lagos',
            employeeTypeId: type1.id,
            amount: 0,
            businessMemberId: m1.id,
            managerEmployeeId: e1.id,
          },
        });
        check(
          'employee can exist without bank information or platform membership',
          e1.bankCode === null &&
            e1.bankName === null &&
            e1.accountNumber === null &&
            e1.businessMemberId === null,
        );
        check(
          'unbanked employee starts blocked and no verification job is scheduled',
          e1.paymentStatus === 'blocked' &&
            e1.accountVerificationStatus === 'unverified' &&
            e1.verificationJobStatus === 'pending' &&
            e1.nextVerificationAttemptAt === null,
        );
        check(
          'financial precision is preserved',
          e1.amount?.toFixed(2) === '12345678901234.56',
        );
        check(
          'business can have multiple employees',
          (await tx.businessEmployee.count({
            where: { businessId: b1.id },
          })) === 2,
        );
        check(
          'same-business member and manager links work',
          e3.businessMemberId === m1.id && e3.managerEmployeeId === e1.id,
        );
        check(
          'employee starts without a tax profile',
          (await tx.employeeTaxProfile.count({
            where: { employeeId: e1.id },
          })) === 0,
        );
        await rejected(
          'cross-business member links rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { businessMemberId: m2.id },
            }),
          'P2003',
        );
        await rejected(
          'cross-business manager links rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { managerEmployeeId: e2.id },
            }),
          'P2003',
        );
        await rejected(
          'self-management rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { managerEmployeeId: e1.id },
            }),
          'Employee_manager_check',
        );
        await rejected(
          'negative compensation rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { amount: -1 },
            }),
          'Employee_amount_check',
        );
        await rejected(
          'untrimmed employee names rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { fullName: ' Untrimmed ' },
            }),
          'Employee_name_check',
        );
        await rejected(
          'unverified employees cannot be bank-payable',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { paymentStatus: 'payable' },
            }),
          'Employee_payment_check',
        );
        await rejected(
          'verification cannot start without bank details',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { verificationJobStatus: 'processing' },
            }),
          'Employee_job_check',
        );
        await rejected(
          'plaintext account numbers rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { accountNumber: '0012345678' },
            }),
          'BusinessEmployee_accountNumber_encrypted',
        );

        const key = randomBytes(32).toString('base64');
        const accountNumber = encryptPayrollField('0012345678', key);
        const banked = await tx.businessEmployee.create({
          data: {
            businessId: b1.id,
            fullName: 'Verified Employee',
            email: `employee-d-${suffix}@example.invalid`,
            state: 'Lagos',
            employeeTypeId: type1.id,
            amount: '0.10',
            bankCode: '001',
            bankName: 'Test Bank',
            accountNumber,
            accountName: encryptPayrollField('Verified Employee', key),
            accountVerificationStatus: 'verified',
            verificationJobStatus: 'completed',
            verificationMode: 'live',
            accountVerifiedAt: new Date(),
            paymentStatus: 'payable',
          },
        });
        const changed = await tx.businessEmployee.update({
          where: { id: banked.id },
          data: { bankCode: '002' },
        });
        check(
          'bank changes invalidate verification and payment eligibility',
          changed.accountVerificationStatus === 'unverified' &&
            changed.paymentStatus === 'blocked' &&
            changed.accountVerifiedAt === null &&
            changed.verificationMode === null,
        );

        const tax = await tx.employeeTaxProfile.create({
          data: {
            businessId: b1.id,
            employeeId: e1.id,
            pensionContributionRate: '7.1234',
            taxIdentificationNumber: encryptPayrollField('00123', key),
          },
        });
        check(
          'optional single tax profile works and unknown contribution applicability stays null',
          tax.employerPensionContributionRate === null &&
            tax.nhfApplicable === null &&
            tax.nhisApplicable === null &&
            tax.pensionContributionRate?.toFixed(4) === '7.1234',
        );
        await rejected(
          'second tax profile rejected',
          () =>
            tx.employeeTaxProfile.create({
              data: { businessId: b1.id, employeeId: e1.id },
            }),
          'P2002',
        );
        await rejected(
          'cross-business tax profile rejected',
          () =>
            tx.employeeTaxProfile.create({
              data: { businessId: b1.id, employeeId: e2.id },
            }),
          'P2003',
        );
        await rejected(
          'invalid employment dates rejected',
          () =>
            tx.employeeTaxProfile.update({
              where: { id: tax.id },
              data: {
                employmentStartDate: new Date('2026-10-08'),
                employmentEndDate: new Date('2026-10-01'),
              },
            }),
          'Tax_dates_check',
        );
        await rejected(
          'invalid contribution rates rejected',
          () =>
            tx.employeeTaxProfile.update({
              where: { id: tax.id },
              data: { pensionContributionRate: -1 },
            }),
          'Tax_rates_check',
        );
        await rejected(
          'tax history prevents employee deletion',
          () => tx.businessEmployee.delete({ where: { id: e1.id } }),
          'P2003',
        );

        await seedEmployeeTypes(tx, b1.id);
        await seedEmployeeTypes(tx, b1.id);
        check(
          'employee type templates seed idempotently within a business',
          (await tx.employeeType.count({ where: { businessId: b1.id } })) === 5,
        );
        const foreignType = type2;
        await rejected(
          'cross-business employee type rejected',
          () =>
            tx.businessEmployee.update({
              where: { id: e1.id },
              data: { employeeTypeId: foreignType.id },
            }),
          'P2003',
        );
        const g1 = await tx.employeeGroup.create({
          data: { businessId: b1.id, name: 'Operations' },
        });
        const g2 = await tx.employeeGroup.create({
          data: { businessId: b2.id, name: 'Operations' },
        });
        await tx.businessEmployeeGroup.create({
          data: { businessId: b1.id, employeeId: e1.id, groupId: g1.id },
        });
        await rejected(
          'duplicate employee group assignments rejected',
          () =>
            tx.businessEmployeeGroup.create({
              data: { businessId: b1.id, employeeId: e1.id, groupId: g1.id },
            }),
          'P2002',
        );
        await rejected(
          'cross-business group assignments rejected',
          () =>
            tx.businessEmployeeGroup.create({
              data: { businessId: b1.id, employeeId: e1.id, groupId: g2.id },
            }),
          'P2003',
        );

        const custom = await tx.role.create({
          data: {
            businessId: b1.id,
            name: 'Custom',
            key: 'custom',
            type: 'custom',
          },
        });
        await tx.rolePermission.create({
          data: { roleId: custom.id, permission: 'employees:view' },
        });
        await tx.roleDeniedPermission.create({
          data: { roleId: custom.id, permission: 'employees:view' },
        });
        const customGrants = await tx.rolePermission.findMany({
          where: { roleId: custom.id },
        });
        const customDenials = await tx.roleDeniedPermission.findMany({
          where: { roleId: custom.id },
        });
        check(
          'custom role denial overrides its grant',
          effectivePermissions(
            customGrants.map((row) => row.permission as Permission),
            customDenials.map((row) => row.permission as Permission),
          ).length === 0,
        );
        await tx.businessMember.update({
          where: { id: m1.id },
          data: {
            roleId: custom.id,
            roleUpdatedByUserId: u2.id,
            roleUpdatedAt: new Date(),
          },
        });
        await rejected(
          'custom roles cannot be assigned across businesses',
          () =>
            tx.businessMember.update({
              where: { id: m2.id },
              data: { roleId: custom.id },
            }),
          'same business',
        );
        await rejected(
          'role scope cannot change after assignment',
          () =>
            tx.role.update({
              where: { id: custom.id },
              data: { businessId: b2.id },
            }),
          'scope cannot be changed',
        );
        await rejected(
          'unknown permission keys rejected',
          () =>
            tx.rolePermission.create({
              data: { roleId: custom.id, permission: 'unknown:permission' },
            }),
          'P2003',
        );
        await rejected(
          'duplicate permission grants rejected',
          () =>
            tx.rolePermission.create({
              data: { roleId: custom.id, permission: 'employees:view' },
            }),
          'P2002',
        );
        await rejected(
          'owner role cannot be archived',
          () =>
            tx.role.update({
              where: { id: 'system-role-owner' },
              data: { status: 'archived' },
            }),
          'System roles',
        );
        await rejected(
          'admins cannot receive owner-only grants',
          () =>
            tx.rolePermission.create({
              data: {
                roleId: 'system-role-admin',
                permission: 'business:update',
              },
            }),
          'not granted',
        );
        await rejected(
          'system roles cannot receive denials',
          () =>
            tx.roleDeniedPermission.create({
              data: {
                roleId: 'system-role-viewer',
                permission: 'members:view',
              },
            }),
          'no explicit denials',
        );
        await tx.businessMember.update({
          where: { id: m1.id },
          data: {
            status: 'removed',
            removedByUserId: u2.id,
            removedAt: new Date(),
            statusUpdatedByUserId: u2.id,
            statusUpdatedAt: new Date(),
          },
        });
        check(
          'removing membership preserves its independent employee record',
          (await tx.businessEmployee.count({ where: { id: e3.id } })) === 1,
        );
        await rejected(
          'membership audit history cannot be deleted',
          () => tx.businessMember.delete({ where: { id: m1.id } }),
          'history must be retained',
        );
        check(
          'existing user preferences remain functional',
          (
            await tx.userPreference.findUniqueOrThrow({
              where: { userId: u1.id },
            })
          ).onboardingUseCases.length === 0,
        );
        // Nothing from this integrity run, including role seed changes, is persisted.
        throw new IntegrityRollback();
      },
      { timeout: 180000, maxWait: 60000 },
    );
  } catch (error) {
    if (!(error instanceof IntegrityRollback)) throw error;
    console.log(
      `${checks} live database integrity checks passed; all test changes rolled back.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
