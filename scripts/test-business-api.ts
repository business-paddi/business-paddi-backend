import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';

import { BusinessAccessService } from '../src/business/business-access.service';
import { BusinessService } from '../src/business/business.service';
import { EmployeeService } from '../src/business/employee.service';
import { InviteService } from '../src/business/invite.service';
import { EmployeeQueryDto } from '../src/business/business.dto';
import { seedSystemRoles } from '../src/business-foundation/seed';
import { databaseErrorSummary } from './database-error';

class TestRollback extends Error {}
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 15000,
    }),
  });
  let count = 0;
  try {
    console.log('Checking database connectivity...');
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$transaction(
      async (tx) => {
        // Nest services use savepoints instead of commits during this rollback-only run.
        let sequence = 0;
        const nested = async (
          operation:
            | ((db: Prisma.TransactionClient) => Promise<unknown>)
            | Promise<unknown>[],
        ) => {
          const name = `api_case_${++sequence}`;
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
          try {
            const result = Array.isArray(operation)
              ? await Promise.all(operation)
              : await operation(tx);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
            return result;
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
            throw error;
          }
        };
        const database = new Proxy(tx, {
          get(target, property) {
            return property === '$transaction'
              ? nested
              : Reflect.get(target, property);
          },
        }) as unknown as PrismaService;
        const access = new BusinessAccessService(database);
        const config = new ConfigService({
          FRONTEND_URL: 'https://frontend.example.invalid',
          PAYROLL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        });
        const invites = new InviteService(database, access);
        const employees = new EmployeeService(database, access, config);
        const businesses = new BusinessService(
          database,
          access,
          invites,
          employees,
        );
        const check = (label: string, value: unknown) => {
          assert.ok(value, label);
          count++;
          console.log(`PASS: ${label}`);
        };
        const rejects = async (
          label: string,
          operation: () => Promise<unknown>,
          status?: number,
        ) => {
          await assert.rejects(
            operation,
            (error) =>
              typeof error === 'object' &&
              error !== null &&
              (status === undefined ||
                ('status' in error && error.status === status)),
          );
          count++;
          console.log(`PASS: ${label}`);
        };
        await seedSystemRoles(tx);
        const suffix = randomUUID();
        const owner = await tx.user.create({
          data: {
            name: 'API owner',
            email: `api-owner-${suffix}@example.invalid`,
            emailVerifiedAt: new Date(),
          },
        });
        const invitedUser = await tx.user.create({
          data: {
            name: 'API employee',
            email: `api-employee-${suffix}@example.invalid`,
            emailVerifiedAt: new Date(),
          },
        });
        const outsider = await tx.user.create({
          data: {
            name: 'API outsider',
            email: `api-outside-${suffix}@example.invalid`,
            emailVerifiedAt: new Date(),
          },
        });
        const request = {
          business: { name: 'API Test Business' },
          employees: [
            {
              fullName: 'Ada Okafor',
              email: invitedUser.email,
              state: 'Lagos',
              employeeTypeKey: 'full_time',
              connectToPlatform: true,
            },
          ],
        };
        const result = (await businesses.onboard(
          owner.id,
          request,
          suffix,
        )) as {
          business: { id: string };
          membership: { role: { key: string } };
          employees: { id: string; amount: string | null }[];
          invitations: { id: string; deliveryStatus: string }[];
        };
        const businessId = result.business.id;
        const employeeId = result.employees[0].id;
        check(
          'business creates active owner membership atomically',
          result.membership.role.key === 'owner' &&
            (await tx.businessMember.count({
              where: { businessId, userId: owner.id, status: 'active' },
            })) === 1,
        );
        check(
          'five default employee types are available',
          (await tx.employeeType.count({ where: { businessId } })) === 5,
        );
        const employee = await tx.businessEmployee.findUniqueOrThrow({
          where: { id: employeeId },
        });
        check(
          'minimal registration leaves amount, banking and membership unknown',
          employee.amount === null &&
            employee.accountNumber === null &&
            employee.businessMemberId === null &&
            employee.paymentStatus === 'blocked',
        );
        check(
          'minimal registration creates no tax profile or platform account',
          (await tx.employeeTaxProfile.count({ where: { employeeId } })) ===
            0 &&
            (await tx.user.count({ where: { email: invitedUser.email } })) ===
              1,
        );
        check(
          'connection intent is stored and delivery accurately reported',
          result.invitations[0].deliveryStatus === 'pending',
        );
        check(
          'invitation does not create membership before acceptance',
          (await tx.businessMember.count({
            where: { businessId, userId: invitedUser.id },
          })) === 0,
        );
        const replay = (await businesses.onboard(
          owner.id,
          request,
          suffix,
        )) as { business: { id: string } };
        check(
          'idempotent onboarding returns the same business',
          replay.business.id === businessId &&
            (await tx.business.count({ where: { id: businessId } })) === 1,
        );
        await rejects(
          'idempotency rejects changed payload',
          () =>
            businesses.onboard(
              owner.id,
              { business: { name: 'Changed' } },
              suffix,
            ),
          409,
        );
        check(
          'outsider business list is empty',
          (await businesses.list(outsider.id)).items.length === 0,
        );
        await rejects(
          'unrelated business access is denied',
          () => businesses.get(outsider.id, businessId),
          404,
        );
        const before = await tx.business.count();
        await rejects(
          'employee failure rolls back business, membership and invitation creation',
          () =>
            businesses.onboard(owner.id, {
              business: { name: 'Will roll back' },
              employees: [
                { ...request.employees[0], employeeTypeKey: 'invalid' },
              ],
            }),
          400,
        );
        check(
          'failed onboarding leaves no partial business',
          (await tx.business.count()) === before,
        );
        await rejects(
          'wrong verified email cannot accept invitation',
          () => invites.acceptById(outsider.id, result.invitations[0].id),
          403,
        );
        await tx.user.update({
          where: { id: invitedUser.id },
          data: { emailVerifiedAt: null },
        });
        await rejects(
          'unverified invited identity cannot accept',
          () => invites.acceptById(invitedUser.id, result.invitations[0].id),
          403,
        );
        await tx.user.update({
          where: { id: invitedUser.id },
          data: { emailVerifiedAt: new Date() },
        });
        const accepted = await invites.acceptById(
          invitedUser.id,
          result.invitations[0].id,
        );
        check(
          'acceptance creates membership and links the existing employee',
          accepted.membership.role.key === 'employee' &&
            (
              await tx.businessEmployee.findUniqueOrThrow({
                where: { id: employeeId },
              })
            ).businessMemberId === accepted.membership.id,
        );
        await rejects(
          'accepted invitation cannot be replayed',
          () => invites.acceptById(invitedUser.id, result.invitations[0].id),
          409,
        );
        await rejects(
          'employee role cannot update business',
          () =>
            businesses.update(invitedUser.id, businessId, { name: 'Denied' }),
          403,
        );
        check(
          'employee can read their linked record without banking information',
          !(
            'accountNumber' in
            (await employees.get(invitedUser.id, businessId, employeeId))
              .employee
          ),
        );
        await tx.businessMember.update({
          where: { id: accepted.membership.id },
          data: {
            status: 'suspended',
            statusUpdatedByUserId: owner.id,
            statusUpdatedAt: new Date(),
          },
        });
        await rejects(
          'suspended membership denies business access',
          () => businesses.get(invitedUser.id, businessId),
          403,
        );
        const second = (await businesses.create(owner.id, {
          name: 'Second Business',
        })) as { business: { id: string }; employeeTypes: { id: string }[] };
        check(
          'owner can belong to multiple businesses',
          (await businesses.list(owner.id)).items.length === 2,
        );
        await rejects(
          'foreign employee type rejected',
          () =>
            employees.create(owner.id, businessId, {
              fullName: 'Foreign',
              email: 'foreign@example.invalid',
              state: 'Lagos',
              employeeTypeId: second.employeeTypes[0].id,
            }),
          400,
        );
        const type = await tx.employeeType.findFirstOrThrow({
          where: { businessId, status: 'active' },
        });
        const configured = await employees.create(owner.id, businessId, {
          fullName: 'Configured employee',
          email: `configured-${suffix}@example.invalid`,
          state: 'Lagos',
          employeeTypeId: type.id,
          amount: '0.00',
          bankCode: '001',
          accountNumber: '0012345678',
          jobTitle: 'Engineer',
        });
        const configuredRow = await tx.businessEmployee.findUniqueOrThrow({
          where: { id: configured.employee.id },
        });
        check(
          'optional zero compensation at registration is distinct from unknown',
          configuredRow.amount?.toFixed(2) === '0.00' &&
            configuredRow.jobTitle === 'Engineer',
        );
        check(
          'optional banking at registration is encrypted and never makes an employee payable',
          configuredRow.accountNumber?.startsWith('enc:v1:') &&
            configuredRow.paymentStatus === 'blocked' &&
            configuredRow.accountVerificationStatus === 'unverified',
        );
        await employees.archive(owner.id, businessId, configured.employee.id);
        await rejects('duplicate nonarchived employee email rejected', () =>
          employees.create(owner.id, businessId, {
            fullName: 'Duplicate',
            email: invitedUser.email,
            state: 'Lagos',
            employeeTypeId: type.id,
          }),
        );
        await employees.update(owner.id, businessId, employeeId, {
          amount: '50.20',
          bankCode: '001',
          accountNumber: '0012345678',
        });
        const banked = await tx.businessEmployee.findUniqueOrThrow({
          where: { id: employeeId },
        });
        check(
          'banking is encrypted and remains unverified and blocked',
          banked.accountNumber?.startsWith('enc:v1:') &&
            banked.accountVerificationStatus === 'unverified' &&
            banked.paymentStatus === 'blocked',
        );
        const tax = await employees.putTax(owner.id, businessId, employeeId, {
          taxIdentificationNumber: '00123',
          pensionAccountNumber: '001234',
          pensionContributionRate: '7.1234',
        });
        check(
          'tax profile is added later with fixed precision and authorized decryption',
          tax.taxProfile?.taxIdentificationNumber === '00123' &&
            tax.taxProfile.pensionContributionRate === '7.1234',
        );
        check(
          'stored statutory identifiers are encrypted',
          (
            await tx.employeeTaxProfile.findUniqueOrThrow({
              where: { employeeId },
            })
          ).taxIdentificationNumber?.startsWith('enc:v1:'),
        );
        await employees.putTax(owner.id, businessId, employeeId, {
          nhfApplicable: false,
        });
        check(
          'tax PUT upserts one current profile',
          (await tx.employeeTaxProfile.count({ where: { employeeId } })) === 1,
        );
        await rejects(
          'cross-business tax access rejected',
          () => employees.tax(owner.id, second.business.id, employeeId),
          404,
        );
        await rejects(
          'employee role cannot read tax profile',
          () => employees.tax(invitedUser.id, businessId, employeeId),
          403,
        );

        const failed = await invites.create(owner.id, businessId, {
          email: outsider.email,
        });
        await rejects('duplicate pending invitation is rejected', () =>
          invites.create(owner.id, businessId, { email: outsider.email }),
        );
        check(
          'member-only invitation stays pending without membership creation',
          failed.invitation.deliveryStatus === 'pending' &&
            (await tx.businessMember.count({
              where: { businessId, userId: outsider.id },
            })) === 0,
        );

        const resent = await invites.resend(
          owner.id,
          businessId,
          failed.invitation.id,
        );
        check(
          'resend leaves delivery pending',
          resent.invitation.deliveryStatus === 'pending',
        );
        await invites.revoke(owner.id, businessId, failed.invitation.id);
        await rejects(
          'revoked invitation cannot be accepted',
          () => invites.acceptById(outsider.id, failed.invitation.id),
          409,
        );
        const expired = await invites.create(owner.id, businessId, {
          email: outsider.email,
        });
        await tx.businessInvite.update({
          where: { id: expired.invitation.id },
          data: { expiresAt: new Date(0) },
        });
        await rejects(
          'expired pending invitation cannot be accepted',
          () => invites.acceptById(outsider.id, expired.invitation.id),
          410,
        );
        await employees.archive(owner.id, businessId, employeeId);
        check(
          'employee archival preserves membership and tax history',
          (await tx.businessMember.count({
            where: { id: accepted.membership.id },
          })) === 1 &&
            (await tx.employeeTaxProfile.count({ where: { employeeId } })) ===
              1,
        );
        await employees.create(owner.id, businessId, {
          fullName: 'Replacement',
          email: invitedUser.email,
          state: 'Lagos',
          employeeTypeId: type.id,
        });
        check(
          'archived email can be reused within the business',
          (await tx.businessEmployee.count({
            where: { businessId, email: invitedUser.email },
          })) === 2,
        );
        const list = await employees.list(
          owner.id,
          businessId,
          new EmployeeQueryDto(),
        );
        check(
          'employee list is paginated and excludes sensitive identifiers',
          list.pagination.total === 1 && !('accountNumber' in list.items[0]),
        );
        check(
          'summary uses actual database counts',
          (await businesses.summary(owner.id, businessId)).totalEmployees === 1,
        );
        throw new TestRollback();
      },
      { timeout: 180000, maxWait: 15000 },
    );
  } catch (error) {
    if (!(error instanceof TestRollback)) throw error;
    console.log(
      `${count} live business API service checks passed; all test data rolled back.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
