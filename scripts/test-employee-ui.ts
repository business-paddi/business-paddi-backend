import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import { BusinessAccessService } from '../src/business/business-access.service';
import { BusinessService } from '../src/business/business.service';
import { EmployeeService } from '../src/business/employee.service';
import { GroupService } from '../src/business/group.service';
import { EmployeeLifecycleService } from '../src/business/employee-lifecycle.service';
import { EmployeeQueryDto } from '../src/business/business.dto';
import type { InviteService } from '../src/business/invite.service';

class FixtureRollback extends Error {}
async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 }) });
  let count = 0;
  const check = (label: string, value: unknown) => { assert.ok(value, label); console.log(`PASS: ${label}`); count++; };
  try {
    await prisma.$transaction(async (tx) => {
      let sequence = 0;
      const nested = async (operation: ((db: Prisma.TransactionClient) => Promise<unknown>) | Promise<unknown>[]) => {
        const name = `employee_ui_${++sequence}`;
        await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
        try {
          const result = Array.isArray(operation) ? await Promise.all(operation) : await operation(tx);
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
          await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      };
      const database = new Proxy(tx, { get(target, property) { return property === '$transaction' ? nested : Reflect.get(target, property); } }) as unknown as PrismaService;
      const access = new BusinessAccessService(database);
      const employees = new EmployeeService(database, access, new ConfigService());
      const businesses = new BusinessService(database, access, {} as InviteService, employees);
      const groups = new GroupService(database, access);
      const lifecycle = new EmployeeLifecycleService(database, access);
      const grantsBefore = await tx.rolePermission.findMany({ orderBy: [{ roleId: 'asc' }, { permission: 'asc' }] });
      const role = await tx.role.findFirstOrThrow({ where: { key: 'owner', type: 'system', businessId: null } });
      const actor = await tx.user.create({ data: { name: 'Employee UI fixture', email: `employee-ui-${randomUUID()}@example.invalid`, emailVerifiedAt: new Date() } });
      await tx.$queryRaw`SELECT set_config('business_paddi.actor_id', ${actor.id}, true)`;
      const business = await tx.business.create({ data: { name: 'Employee UI fixture' } });
      const otherBusiness = await tx.business.create({ data: { name: 'Employee UI foreign fixture' } });
      for (const businessId of [business.id, otherBusiness.id]) await tx.businessMember.create({ data: { businessId, userId: actor.id, roleId: role.id } });

      const created = await businesses.createGroup(actor.id, business.id, { name: 'Engineering', color: '#3456AB', icon: 'Code' });
      const fresh = await groups.get(actor.id, business.id, created.group.id);
      check('custom appearance survives a fresh database read', fresh.group.color === '#3456AB' && fresh.group.icon === 'Code');
      const list = await businesses.groups(actor.id, business.id);
      check('list and detail return the same appearance', list.items.some((item) => item.id === fresh.group.id && item.color === fresh.group.color && item.icon === fresh.group.icon));
      const audit = await tx.auditEvent.findFirst({ where: { businessId: business.id, userId: actor.id, eventType: 'business.employee_group.appearance_changed' } });
      check('appearance creation is attributed to the creator and contains values', audit && JSON.stringify(audit.changes).includes('#3456AB'));
      await groups.update(actor.id, business.id, fresh.group.id, { color: '#abcdef', icon: 'Briefcase' });
      const updated = await groups.get(actor.id, business.id, fresh.group.id);
      check('appearance updates persist', updated.group.color === '#abcdef' && updated.group.icon === 'Briefcase');
      await groups.update(actor.id, business.id, fresh.group.id, { color: null, icon: null });
      const reset = await groups.get(actor.id, business.id, fresh.group.id);
      check('null resets persisted appearance defaults', reset.group.color === null && reset.group.icon === null);
      await assert.rejects(() => groups.update(actor.id, otherBusiness.id, fresh.group.id, { color: '#ffffff' }), (error: { status?: number }) => error.status === 404);
      check('cross-business group update is rejected', true);
      await assert.rejects(() => nested(() => tx.employeeGroup.update({ where: { id: fresh.group.id }, data: { color: '#123' } })));
      await assert.rejects(() => nested(() => tx.employeeGroup.update({ where: { id: fresh.group.id }, data: { icon: 'untrusted-icon' } })));
      check('database constraints reject invalid hex and icons', true);

      const employeeType = await tx.employeeType.create({ data: { businessId: business.id, name: 'Full time', key: 'full_time' } });
      const employee = await tx.businessEmployee.create({ data: { businessId: business.id, fullName: 'Unlinked fixture employee', email: 'fixture@example.invalid', state: 'Lagos', employeeTypeId: employeeType.id } });
      await tx.businessEmployeeGroup.create({ data: { businessId: business.id, employeeId: employee.id, groupId: fresh.group.id } });
      const scheduledFor = new Date(Date.now() + 120000).toISOString();
      await lifecycle.mutate(actor.id, business.id, employee.id, 'schedule', scheduledFor);
      const detail = await employees.get(actor.id, business.id, employee.id);
      const listed = await employees.list(actor.id, business.id, new EmployeeQueryDto());
      check('pending deletion appears consistently for employees without accounts', detail.employee.businessMemberId === null && detail.employee.status === 'scheduled_for_deletion' && listed.items.find((item) => item.id === employee.id)?.status === detail.employee.status);
      check('UTC schedule is returned by list and detail', detail.employee.deletionScheduledAt?.toISOString() === scheduledFor && listed.items.find((item) => item.id === employee.id)?.deletionScheduledAt?.toISOString() === scheduledFor);
      await assert.rejects(() => employees.update(actor.id, business.id, employee.id, { fullName: 'Bypass' }), (error: { status?: number }) => error.status === 400);
      await assert.rejects(() => employees.archive(actor.id, business.id, employee.id), (error: { status?: number }) => error.status === 400);
      check('ordinary editing and archive cannot bypass deletion state', true);
      await lifecycle.mutate(actor.id, business.id, employee.id, 'cancel');
      const cancelled = await tx.businessEmployee.findUniqueOrThrow({ where: { id: employee.id } });
      check('cancellation restores prior status without making payroll payable', cancelled.status === 'active' && cancelled.paymentStatus === 'blocked' && cancelled.deletionScheduledAt === null);
      await lifecycle.mutate(actor.id, business.id, employee.id, 'schedule', scheduledFor);
      const processed = await lifecycle.processDue(new Date(new Date(scheduledFor).getTime() + 1), business.id);
      check('scheduled worker completes due deletion in the fixture business only', processed === 1);
      const deleted = await employees.get(actor.id, business.id, employee.id);
      check('soft-deleted employee remains available in detail', deleted.employee.status === 'deleted' && deleted.employee.deletedAt !== null && deleted.employee.businessMemberId === null);
      const filtered = await employees.list(actor.id, business.id, Object.assign(new EmployeeQueryDto(), { status: 'deleted' }));
      const defaults = await employees.list(actor.id, business.id, new EmployeeQueryDto());
      check('deleted records are explicitly listable and excluded by default', filtered.items.some((item) => item.id === employee.id) && !defaults.items.some((item) => item.id === employee.id));
      check('group membership survives soft deletion', await tx.businessEmployeeGroup.count({ where: { businessId: business.id, employeeId: employee.id } }) === 1);
      await lifecycle.mutate(actor.id, business.id, employee.id, 'restore');
      const restored = await tx.businessEmployee.findUniqueOrThrow({ where: { id: employee.id } });
      check('restoration is archived, nonpayable and clears lifecycle metadata', restored.status === 'archived' && restored.paymentStatus === 'blocked' && restored.deletedAt === null && restored.deletionRequestedAt === null);
      await assert.rejects(() => lifecycle.mutate(actor.id, otherBusiness.id, employee.id, 'delete'), (error: { status?: number }) => error.status === 404);
      check('cross-business employee deletion is rejected', true);
      await assert.rejects(() => nested(() => tx.businessEmployee.update({ where: { id: employee.id }, data: { status: 'deleted' } })));
      check('database rejects incomplete lifecycle state', true);
      check('lifecycle events remain auditable', await tx.auditEvent.count({ where: { businessId: business.id, eventType: { in: ['business.employee.deletion_scheduled', 'business.employee.deletion_cancelled', 'business.employee.deleted', 'business.employee.restored'] } } }) === 5);
      const grantsAfter = await tx.rolePermission.findMany({ orderBy: [{ roleId: 'asc' }, { permission: 'asc' }] });
      check('existing role grants are unchanged', JSON.stringify(grantsBefore) === JSON.stringify(grantsAfter));
      throw new FixtureRollback();
    }, { maxWait: 15000, timeout: 180000 });
  } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
  finally { await prisma.$disconnect(); }
  console.log(`${count} checks passed; all fixtures and changes rolled back.`);
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
