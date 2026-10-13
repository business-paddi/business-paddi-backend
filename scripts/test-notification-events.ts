import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { EmployeeService } from '../src/business/employee.service';
import { BusinessAccessService } from '../src/business/business-access.service';
import type { PrismaService } from '../src/database/prisma.service';
import { databaseErrorSummary } from './database-error';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const schema = `notification_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
  });
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let created = false;
  let passed = 0;
  const check = (name: string, value: unknown) => {
    assert.ok(value, name);
    passed++;
    console.log(`PASS: ${name}`);
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const url = new URL(process.env.DATABASE_URL);
    url.hostname = url.hostname.replace('-pooler.', '.');
    pool = new Pool({
      connectionString: url.toString(),
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 30000,
    });
    assert.equal(
      (await pool.query('SELECT current_schema() AS name')).rows[0].name,
      schema,
    );
    for (const entry of (
      await readdir('prisma/migrations', { withFileTypes: true })
    )
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      let sql = (
        await readFile(`prisma/migrations/${entry.name}/migration.sql`, 'utf8')
      ).replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
      const addition = sql.match(
        /^ALTER TYPE "BusinessMemberStatus" ADD VALUE IF NOT EXISTS 'pending_approval';/,
      );
      if (addition) {
        await pool.query(addition[0]);
        sql = sql.slice(addition[0].length);
      }
      await pool.query(sql);
    }
    console.log('Isolated schema migrated; testing durable event effects.');
    await pool.query(`INSERT INTO "User" ("id","email","name","updatedAt","emailVerifiedAt") VALUES ('reviewer','reviewer@example.invalid','Reviewer',now(),now()),('coordinator','coordinator@example.invalid','Coordinator',now(),now()),('recipient','recipient@example.invalid','Recipient',now(),now()),('other','other@example.invalid','Other',now(),now());
      INSERT INTO "Business" ("id","name","updatedAt") VALUES ('b','Test business',now()),('foreign','Foreign business',now());
      INSERT INTO "Permission" ("key") VALUES ('roles:assign'),('members:invite'),('members:view'),('reports:view'),('employees:view'),('employees:update'),('audit_logs:view') ON CONFLICT DO NOTHING;
      INSERT INTO "Role" ("id","businessId","name","key","type","updatedAt") VALUES ('reviewer-role','b','Reviewer','reviewer','custom',now()),('coordinator-role','b','Coordinator','coordinator','custom',now()),('target','b','Report reader','report_reader','custom',now()),('foreign-role','foreign','Foreign reviewer','reviewer','custom',now());
      INSERT INTO "RolePermission" ("roleId","permission") SELECT 'reviewer-role',"key" FROM "Permission";
      INSERT INTO "RolePermission" ("roleId","permission") VALUES ('coordinator-role','roles:assign'),('coordinator-role','members:invite'),('target','reports:view');
      INSERT INTO "RolePermission" ("roleId","permission") SELECT 'foreign-role',"key" FROM "Permission";
      INSERT INTO "BusinessMember" ("id","businessId","userId","roleId","updatedAt") VALUES ('reviewer-member','b','reviewer','reviewer-role',now()),('coordinator-member','b','coordinator','coordinator-role',now()),('foreign-member','foreign','other','foreign-role',now());
      INSERT INTO "BusinessInvite" ("id","businessId","email","roleId","invitedByUserId","tokenHash","expiresAt","updatedAt","requiresApproval") VALUES ('invite','b','recipient@example.invalid','target','coordinator',repeat('a',64),now()+interval '7 days',now(),true);
      INSERT INTO "BusinessMember" ("id","businessId","userId","roleId","status","approvalStatus","approvalRequestedAt","invitedByUserId","updatedAt") VALUES ('candidate','b','recipient','target','pending_approval','pending',now(),'coordinator',now());`);
    const count = async (type: string, user?: string) =>
      Number(
        (
          await pool!.query(
            'SELECT COUNT(*)::int AS n FROM "UserNotification" WHERE "type"=$1 AND ($2::text IS NULL OR "userId"=$2)',
            [type, user ?? null],
          )
        ).rows[0].n,
      );
    check(
      'only qualified reviewer receives approval request',
      (await count('membership_approval_requested', 'reviewer')) === 1 &&
        (await count('membership_approval_requested', 'coordinator')) === 0 &&
        (await count('membership_approval_requested', 'other')) === 0,
    );
    await pool.query(
      `UPDATE "BusinessMember" SET "updatedAt"=now() WHERE "id"='candidate'`,
    );
    check(
      'no-op updates do not repeat approval alerts',
      (await count('membership_approval_requested')) === 1,
    );
    await pool.query(`UPDATE "BusinessInvite" SET "status"='accepted',"acceptedAt"=now() WHERE "id"='invite';
      UPDATE "BusinessMember" SET "status"='active',"approvalStatus"='approved',"approvalReviewedByUserId"='reviewer',"approvalReviewedAt"=now(),"statusUpdatedByUserId"='reviewer',"statusUpdatedAt"=now() WHERE "id"='candidate';`);
    check(
      'inviter receives acceptance and recipient receives approval',
      (await count('business_invite_accepted', 'coordinator')) === 1 &&
        (await count('membership_approved', 'recipient')) === 1,
    );
    await pool.query(
      `UPDATE "BusinessMember" SET "status"='suspended',"statusUpdatedByUserId"='reviewer',"statusUpdatedAt"=now() WHERE "id"='candidate'`,
    );
    check(
      'suspended member receives access-change notification',
      (await count('membership_access_changed', 'recipient')) === 1,
    );
    const before = await count('membership_access_changed', 'recipient');
    await pool.query('BEGIN');
    await pool.query(
      `UPDATE "BusinessMember" SET "status"='active',"statusUpdatedByUserId"='reviewer',"statusUpdatedAt"=now() WHERE "id"='candidate'`,
    );
    await pool.query('ROLLBACK');
    check(
      'rolled-back changes do not leave notifications',
      (await count('membership_access_changed', 'recipient')) === before,
    );
    await pool.query(`INSERT INTO "EmployeeType" ("id","businessId","name","key","updatedAt") VALUES ('employee-type','b','Full time','full_time',now());
      INSERT INTO "BusinessEmployee" ("id","businessId","businessMemberId","fullName","employeeTypeId","email","state","updatedAt") VALUES ('employee','b','candidate','Recipient','employee-type','recipient@example.invalid','Lagos',now());
      UPDATE "BusinessEmployee" SET "amount"=100000 WHERE "id"='employee';`);
    check(
      'salary change notifies linked employee and payroll reviewer',
      (await count('employee_financial_details_changed', 'recipient')) === 1 &&
        (await count('employee_financial_details_changed', 'reviewer')) === 1 &&
        (await count('employee_financial_details_changed', 'other')) === 0,
    );
    const financialPayload = await pool.query(
      `SELECT "message","data" FROM "UserNotification" WHERE "type"='employee_financial_details_changed'`,
    );
    check(
      'financial notifications contain no salary or account values',
      !JSON.stringify(financialPayload.rows).includes('100000'),
    );
    await pool.query(`INSERT INTO "InventoryCategory" ("id","businessId","name","nameKey","updatedAt") VALUES ('category','b','Test','test',now());
      INSERT INTO "InventoryProduct" ("id","businessId","categoryId","name","sku","purchaseCostMinor","sellingPriceMinor","availableQuantity","lowStockThreshold","updatedAt") VALUES ('product','b','category','Test product','SKU-1',100,200,1,5,now());
      INSERT INTO "InventoryShortage" ("id","businessId","productId","classification","threshold","minimumStock","startedAt") VALUES ('shortage','b','product','low_stock',5,1,now());`);
    check(
      'stock alert reaches inventory managers in the correct tenant',
      (await count('inventory_shortage', 'reviewer')) === 1 &&
        (await count('inventory_shortage', 'other')) === 0,
    );
    await pool.query(
      `UPDATE "InventoryShortage" SET "minimumStock"=0 WHERE "id"='shortage'`,
    );
    check(
      'same shortage episode does not generate repeated alerts',
      (await count('inventory_shortage')) === 1,
    );
    await pool.query(`INSERT INTO "BusinessInvite" ("id","businessId","email","roleId","invitedByUserId","tokenHash","expiresAt","updatedAt") VALUES ('failed-invite','b','mail@example.invalid','target','coordinator',repeat('b',64),now()+interval '7 days',now());
      INSERT INTO "InviteEmailDelivery" ("id","inviteId","generation","payloadCiphertext","updatedAt") VALUES ('failed-delivery','failed-invite',1,'v1.encrypted',now());
      UPDATE "InviteEmailDelivery" SET "state"='failed' WHERE "id"='failed-delivery';`);
    check(
      'permanent mail failure notifies inviter once',
      (await count('invite_delivery_failed', 'coordinator')) === 1,
    );
    await pool.query(`INSERT INTO "AuditEvent" ("eventId","userId","eventType","category","outcome") VALUES ('password-event','recipient','account.password.changed','account','success');
      INSERT INTO "AuditEvent" ("eventId","userId","eventType","category","outcome","userSessionId") VALUES ('replay-1','recipient','security.refresh_token.replay_detected','security','blocked','session-a'),('replay-2','recipient','security.refresh_token.replay_detected','security','blocked','session-a');`);
    check(
      'security alerts persist and repeated replay is deduplicated',
      (await count('account_security', 'recipient')) === 2,
    );
    await pool.query(`INSERT INTO "UserSession" ("userSessionId","userId","userAgent") VALUES ('old-browser','recipient','Browser A'),('new-browser','recipient','Browser B');
      INSERT INTO "AuditEvent" ("eventId","userId","eventType","category","outcome","userSessionId","userAgent") VALUES ('new-login','recipient','authentication.login.succeeded','authentication','success','new-browser','Browser B');`);
    check(
      'sign-in from a previously unseen browser creates an alert',
      (await count('account_security', 'recipient')) === 3,
    );
    await pool.query(
      `INSERT INTO "UserPreference" ("userId","updatedAt") VALUES ('recipient',now()); UPDATE "UserPreference" SET "twoFactorEnabled"=true WHERE "userId"='recipient'; UPDATE "UserPreference" SET "twoFactorEnabled"=true WHERE "userId"='recipient';`,
    );
    check(
      'unchanged two-factor settings do not repeat security alerts',
      (await count('account_security', 'recipient')) === 4,
    );
    await pool.query(
      `INSERT INTO "RoleDeniedPermission" ("roleId","permission") VALUES ('reviewer-role','reports:view');`,
    );
    check(
      'explicit permission denials remove reviewer eligibility',
      (
        await pool.query(
          `SELECT * FROM authorized_business_recipients('b',ARRAY['roles:assign','reports:view'])`,
        )
      ).rowCount === 0,
    );
    await pool.query(
      `DELETE FROM "RoleDeniedPermission" WHERE "roleId"='reviewer-role' AND "permission"='reports:view';`,
    );
    check(
      'mail failure is audited as failure with warning severity',
      (
        await pool.query(
          `SELECT 1 FROM "AuditEvent" WHERE "eventType"='business.invite.delivery_failed' AND "outcome"='failure' AND "severity"='warning'`,
        )
      ).rowCount === 1,
    );
    const audits = await pool.query(
      `SELECT "eventType","changes","metadata" FROM "AuditEvent" WHERE "businessId"='b'`,
    );
    check(
      'business mutations are audited without financial values',
      audits.rows.some(
        (row) => row.eventType === 'business.employee.updated',
      ) && !JSON.stringify(audits.rows).includes('100000'),
    );
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    const database = prisma as unknown as PrismaService;
    const employees = new EmployeeService(
      database,
      new BusinessAccessService(database),
      new ConfigService({
        PAYROLL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
    );
    const financialAuditCount = () =>
      prisma!.auditEvent.count({
        where: { businessId: 'b', eventType: 'business.employee.updated' },
      });
    const financialBefore = await financialAuditCount();
    const saved = await employees.putTax('reviewer', 'b', 'employee', {
      taxResidenceState: 'Lagos',
      amount: '200000.00',
      payFrequency: 'monthly',
      currency: 'NGN',
      bankCode: '058',
      bankName: 'GTBank',
      accountNumber: '0012345678',
      accountName: 'Recipient',
    });
    check(
      'combined tax-profile save persists salary and decrypted authorized bank response',
      saved.taxProfile?.taxResidenceState === 'Lagos' &&
        saved.employee.amount === '200000.00' &&
        saved.employee.accountNumber === '0012345678' && saved.employee.accountName==='Recipient',
    );
    check(
      'combined tax-profile save encrypts account details at rest',
      (
        await prisma.businessEmployee.findUniqueOrThrow({
          where: { id: 'employee' },
        })
      ).accountNumber?.startsWith('enc:v1:'),
    );
    check(
      'combined tax-profile save records one employee financial audit',
      (await financialAuditCount()) === financialBefore + 1,
    );
    await employees.putTax('reviewer', 'b', 'employee', {
      amount: '200000.00',
      accountNumber: '0012345678',
      accountName: 'Recipient',
    });
    check(
      'unchanged bank and salary values do not produce another employee audit',
      (await financialAuditCount()) === financialBefore + 1,
    );
    await employees.update('reviewer', 'b', 'employee', {
      amount: '220000.00',
    });
    check(
      'ordinary employee patch also audits salary changes',
      (await financialAuditCount()) === financialBefore + 2,
    );
    let rolledBack = false;
    try {
      await employees.putTax('reviewer', 'b', 'employee', {
        taxResidenceState: 'Abia',
        amount: '-1.00',
      });
    } catch {
      rolledBack = true;
    }
    check(
      'failed employee write rolls back tax-profile change and audit',
      rolledBack &&
        (
          await prisma.employeeTaxProfile.findUniqueOrThrow({
            where: { employeeId: 'employee' },
          })
        ).taxResidenceState === 'Lagos' &&
        (await financialAuditCount()) === financialBefore + 2,
    );
    check(
      'combined write audit includes actor without exposing private values',
      (
        await prisma.auditEvent.findMany({
          where: {
            businessId: 'b',
            eventType: 'business.employee.updated',
            userId: 'reviewer',
          },
        })
      ).length >= 2 &&
        !JSON.stringify(
          await prisma.auditEvent.findMany({ where: { businessId: 'b' } }),
        ).includes('0012345678'),
    );
    await employees.update('reviewer','b','employee',{accountNumber:'0012345679',accountName:'Recipient'});
    check('bank identity change retains explicitly entered unverified name',(await employees.tax('reviewer','b','employee')).employee.accountName==='Recipient'&&(await prisma.businessEmployee.findUniqueOrThrow({where:{id:'employee'}})).accountVerificationStatus==='unverified');
    await employees.update('reviewer','b','employee',{accountNumber:'0012345680'});
    check('bank identity change without a replacement clears stale account name',(await employees.tax('reviewer','b','employee')).employee.accountName===null);
    console.log(
      `${passed} notification and business audit database checks passed.`,
    );
  } finally {
    await prisma?.$disconnect();
    await pool?.end();
    if (created) {
      assert.match(schema, /^notification_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log('Isolated schema removed; public data unchanged.');
    }
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
