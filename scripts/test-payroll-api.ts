import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import { BusinessAccessService } from '../src/business/business-access.service';
import { TaskOperationService } from '../src/tasks/task-operation.service';
import { PayrollAccessService } from '../src/payroll/payroll-access.service';
import { PayrollSourceService } from '../src/payroll/payroll-source.service';
import { PayrollEventsService } from '../src/payroll/payroll-events.service';
import { PayrollReadService } from '../src/payroll/payroll-read.service';
import { PayrollService } from '../src/payroll/payroll.service';
import {
  PayrollListDto,
  PayrollRecipientsDto,
  PayrollCandidateDto,
} from '../src/payroll/payroll.dto';
import { encryptPayrollField } from '../src/business-foundation/sensitive-fields';
import { databaseErrorSummary } from './database-error';
const inputs = {
  employmentCategory: 'resident_employee',
  policy: 'ng-2026-monthly-v1',
  taxYear: 2026,
  regularMonthlyCashOnly: true,
  soleEmployment: true,
  claimsReviewed: true,
  pensionApplicable: false,
  pensionableMonthlyAmount: '0.00',
  basicMonthlyAmount: '300000.00',
  housingMonthlyAmount: '0.00',
  transportMonthlyAmount: '0.00',
  annualRentPaid: '0.00',
  annualMortgageInterest: '0.00',
  annualLifeInsurancePremium: '0.00',
  nhisEmployeeMonthlyAmount: '0.00',
  nhisEmployerMonthlyAmount: '0.00',
  evidenceReference: '',
  pensionApplicabilityReason: 'Documented outside compulsory scheme',
};
async function main() {
  const schema = `payroll_test_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const url = new URL(process.env.DATABASE_URL!);
  url.hostname = url.hostname.replace('-pooler.', '.');
  const pool = new Pool({
    connectionString: url.toString(),
    options: `-c search_path=${schema}`,
  });
  let prisma: PrismaClient | undefined,
    created = false,
    passed = 0;
  const check = (label: string, value: unknown) => {
    assert.ok(value, label);
    passed++;
    console.log(`PASS: ${label}`);
  };
  async function rejects(
    label: string,
    work: () => Promise<unknown>,
    code?: string,
  ) {
    try {
      await work();
    } catch (error) {
      if (code) {
        assert.ok(error instanceof HttpException);
        assert.equal((error.getResponse() as { code: string }).code, code);
      }
      check(label, true);
      return;
    }
    throw new Error(`Expected rejection: ${label}`);
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
    const db = prisma as unknown as PrismaService;
    const key = Buffer.alloc(32, 3).toString('base64'),
      config = new ConfigService({
        PAYROLL_ENCRYPTION_KEY: key,
        VERIFICATION_CODE_PEPPER: 'isolated-payroll-pepper',
      });
    const access = new PayrollAccessService(db, new BusinessAccessService(db)),
      source = new PayrollSourceService(db, config),
      events = new PayrollEventsService(access),
      read = new PayrollReadService(
        db,
        access,
        source,
        new TaskOperationService(db, config),
      ),
      service = new PayrollService(db, access, source, read, events);
    for (const id of [
      'preparer',
      'reviewer',
      'editor',
      'viewer',
      'own',
      'outsider',
    ])
      await prisma.user.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          name: id,
          emailVerifiedAt: new Date(),
        },
      });
    for (const id of ['b', 'foreign']) {
      await prisma.business.create({ data: { id, name: id } });
      await prisma.employeeType.create({
        data: {
          id: `type-${id}`,
          businessId: id,
          key: 'full_time',
          name: 'Full time',
        },
      });
    }
    const grants: Record<string, string[]> = {
      preparer: [
        'payments:view',
        'payments:create',
        'payments:approve',
        'payments:cancel',
      ],
      reviewer: ['payments:view', 'payments:approve'],
      editor: ['payments:view', 'payments:create', 'payments:approve'],
      viewer: ['payments:view'],
      own: ['payments:view_own'],
    };
    for (const [id, permissions] of Object.entries(grants)) {
      await prisma.role.create({
        data: { id, businessId: 'b', name: id, key: id, type: 'custom' },
      });
      for (const permission of permissions) {
        await prisma.permission.upsert({
          where: { key: permission },
          create: { key: permission },
          update: {},
        });
        await prisma.rolePermission.create({
          data: { roleId: id, permission },
        });
      }
      await prisma.businessMember.create({
        data: { id: `m-${id}`, businessId: 'b', userId: id, roleId: id },
      });
    }
    for (const [id, businessId, amount] of [
      ['e', 'b', '300000.00'],
      ['zero', 'b', '0.00'],
      ['incomplete', 'b', null],
      ['foreign-e', 'foreign', '300000.00'],
    ] as const) {
      await prisma.businessEmployee.create({
        data: {
          id,
          businessId,
          fullName: id,
          email: `${id}@example.invalid`,
          state: 'Lagos',
          employeeTypeId: `type-${businessId}`,
          amount,
          bankCode: '058',
          bankName: 'Test bank',
          accountNumber: encryptPayrollField('0012345678', key),
          accountName: encryptPayrollField('Ada', key),
        },
      });
      if (id !== 'incomplete')
        await prisma.employeeTaxProfile.create({
          data: {
            businessId,
            employeeId: id,
            taxIdentificationNumber: encryptPayrollField('TEST-TIN', key),
            taxResidenceState: 'Lagos',
            taxResidencyStatus: 'resident',
            employmentStartDate: new Date('2026-01-01'),
            nhfApplicable: false,
            nhisApplicable: false,
            payrollInputs: { ...inputs, basicMonthlyAmount: amount ?? '0.00' },
          },
        });
    }
    const body = (month = '10', employeeIds = ['e']) => ({
      name: `Payroll ${month}`,
      periodStart: `2026-${month}-01`,
      periodEnd: `2026-${month}-${['09', '11'].includes(month) ? '30' : '31'}`,
      payDate: `2026-${month}-${['09', '11'].includes(month) ? '30' : '31'}`,
      payFrequency: 'monthly',
      currency: 'NGN',
      employeeIds,
    });
    const create = async (key: string, month = '10', employeeIds = ['e']) =>
      (await service.create(
        'preparer',
        'b',
        body(month, employeeIds),
        key,
      )) as any;
    const act = async (
      user: string,
      id: string,
      route: any,
      revision: number,
      extra: Record<string, unknown> = {},
      key?: string,
      recipientId?: string,
    ) =>
      (await service.mutate(
        user,
        'b',
        id,
        route,
        { expectedRevision: revision, ...extra } as any,
        key,
        recipientId,
      )) as any;
    await rejects('own-view grant cannot reveal batches', () =>
      read.list('own', 'b', new PayrollListDto()),
    );
    await rejects('outsider cannot view business payroll', () =>
      read.list('outsider', 'b', new PayrollListDto()),
    );
    await rejects('viewer cannot select financial candidates', () =>
      read.candidates('viewer', 'b', new PayrollCandidateDto()),
    );
    await rejects(
      'cross-business selection rolls back the complete draft',
      () => create('bad', '10', ['e', 'foreign-e']),
      'EMPLOYEE_NOT_FOUND',
    );
    check(
      'failed create leaves no payroll, operation or audit',
      (await prisma.payrollBatch.count()) === 0 &&
        (await prisma.payrollOperation.count()) === 0 &&
        (await prisma.auditEvent.count({
          where: { eventType: { startsWith: 'business.payroll.' } },
        })) === 0,
    );
    const draft = await create('draft');
    let b = draft.batch;
    check(
      'unconnected employee is eligible and exact calculation is ready',
      b.recipientCount === 1 &&
        b.totals.netAmount === '263500.00' &&
        b.revision === 1,
    );
    const retry = await create('draft');
    assert.deepEqual(retry, draft);
    check(
      'exact create retry returns original snapshot once',
      (await prisma.payrollBatch.count()) === 1,
    );
    await rejects(
      'same key cannot create a changed request',
      () =>
        service.create(
          'preparer',
          'b',
          { ...body(), name: 'Changed' },
          'draft',
        ),
      'IDEMPOTENCY_CONFLICT',
    );
    const recipients = await read.recipients(
      'viewer',
      'b',
      b.id,
      new PayrollRecipientsDto(),
    );
    let r: any = recipients.items[0];
    check(
      'view-only financial snapshot masks leading-zero account and exposes no tax identifier',
      r.bank.maskedAccountNumber === '******5678' &&
        !JSON.stringify(r).includes('TEST-TIN') &&
        !JSON.stringify(r).includes('0012345678') &&
        r.employee.businessMemberId === null,
    );
    const adjust = {
      clientId: 'loan',
      kind: 'deduction',
      label: 'Loan',
      amount: '1000.00',
      reason: 'Agreed repayment',
    };
    let result = await act(
      'editor',
      b.id,
      'recipient',
      b.revision,
      { adjustments: [adjust] },
      undefined,
      r.id,
    );
    b = result.batch;
    r = result.recipient;
    check(
      'recipient update advances shared revision and recalculates exactly',
      b.revision === 2 && r.totals.netAmount === '262500.00',
    );
    await rejects(
      'stale recipient revision is rejected',
      () =>
        act(
          'preparer',
          b.id,
          'recipient',
          1,
          { adjustments: [] },
          undefined,
          r.id,
        ),
      'REVISION_CONFLICT',
    );
    const stableId = (r.adjustments as any)[0].id;
    result = await act(
      'editor',
      b.id,
      'recipient',
      b.revision,
      { adjustments: [adjust] },
      undefined,
      r.id,
    );
    b = result.batch;
    check(
      'adjustment client identity remains stable across saves',
      result.recipient.adjustments[0].id === stableId,
    );
    await rejects(
      'negative net does not save a partial edit',
      () =>
        act(
          'preparer',
          b.id,
          'recipient',
          b.revision,
          { adjustments: [{ ...adjust, amount: '999999.00' }] },
          undefined,
          r.id,
        ),
      'NEGATIVE_NET_PAY',
    );
    check(
      'failed adjustment preserves batch revision',
      (await read.detail('viewer', 'b', b.id)).batch.revision === b.revision,
    );
    await prisma.businessEmployee.update({
      where: { id: 'e' },
      data: { amount: '350000.00' },
    });
    await rejects(
      'submission rejects changed source without implicit refresh',
      () => act('preparer', b.id, 'submit', b.revision, {}, 'stale-source'),
      'SOURCE_CHANGED',
    );
    result = await act(
      'preparer',
      b.id,
      'refresh',
      b.revision,
      { recipientIds: [r.id] },
      'refresh',
    );
    b = result.batch;
    check(
      'refresh reports only changed field flags and preserves adjustments',
      result.changes[0].changedFields.includes('compensation') &&
        !JSON.stringify(result.changes).includes('350000') &&
        (
          (
            await read.recipients(
              'viewer',
              'b',
              b.id,
              new PayrollRecipientsDto(),
            )
          ).items[0].adjustments as any[]
        ).length === 1,
    );
    result = await act('preparer', b.id, 'submit', b.revision, {}, 'submit');
    b = result.batch;
    const submittedExample = result;
    const sent = await prisma.userNotification.count({
      where: { type: 'payroll_submitted' },
    });
    check(
      'submission excludes every prior financial contributor from notifications',
      b.status === 'submitted' &&
        sent === 1 &&
        (
          await prisma.userNotification.findFirst({
            where: { type: 'payroll_submitted' },
          })
        )?.userId === 'reviewer',
    );
    const replay = await act(
      'preparer',
      b.id,
      'submit',
      b.revision - 1,
      {},
      'submit',
    );
    check(
      'submit replay is exact and does not repeat notification',
      replay.batch.revision === b.revision &&
        (await prisma.userNotification.count({
          where: { type: 'payroll_submitted' },
        })) === sent,
    );
    await rejects(
      'creator cannot approve own submission',
      () =>
        act(
          'preparer',
          b.id,
          'review',
          b.revision,
          { decision: 'approve' },
          'self',
        ),
      'INDEPENDENT_REVIEWER_REQUIRED',
    );
    await rejects(
      'prior financial editor cannot approve',
      () =>
        act(
          'editor',
          b.id,
          'review',
          b.revision,
          { decision: 'approve' },
          'editor-review',
        ),
      'INDEPENDENT_REVIEWER_REQUIRED',
    );
    await rejects(
      'submitted recipients cannot be patched',
      () =>
        act(
          'preparer',
          b.id,
          'recipient',
          b.revision,
          { notes: 'bad' },
          undefined,
          r.id,
        ),
      'INVALID_TRANSITION',
    );
    await rejects('database prevents recipient mutation while submitted', () =>
      prisma!.payrollRecipient.update({
        where: { id: r.id },
        data: { notes: 'bypass' },
      }),
    );
    await rejects(
      'request changes needs a reason',
      () =>
        act(
          'reviewer',
          b.id,
          'review',
          b.revision,
          { decision: 'request_changes' },
          'no-reason',
        ),
      'REVIEW_REASON_REQUIRED',
    );
    result = await act(
      'reviewer',
      b.id,
      'review',
      b.revision,
      { decision: 'request_changes', note: 'Please correct the breakdown' },
      'changes',
    );
    b = result.batch;
    check(
      'changes requested releases duplicate obligation and retains history',
      b.status === 'changes_requested' &&
        (await prisma.payrollObligation.count()) === 0 &&
        (await prisma.payrollHistory.count({
          where: { batchId: b.id, event: 'submitted' },
        })) === 1,
    );
    result = await act('preparer', b.id, 'submit', b.revision, {}, 'resubmit');
    b = result.batch;
    await prisma.businessEmployee.update({
      where: { id: 'e' },
      data: { jobTitle: 'Updated job' },
    });
    await rejects(
      'source freshness is also enforced at approval',
      () =>
        act(
          'reviewer',
          b.id,
          'review',
          b.revision,
          { decision: 'approve' },
          'stale-review',
        ),
      'SOURCE_CHANGED',
    );
    b = (
      await act(
        'reviewer',
        b.id,
        'review',
        b.revision,
        { decision: 'request_changes', note: 'Refresh source' },
        'changes-2',
      )
    ).batch;
    b = (
      await act(
        'preparer',
        b.id,
        'refresh',
        b.revision,
        { recipientIds: [r.id] },
        'refresh-2',
      )
    ).batch;
    b = (await act('preparer', b.id, 'submit', b.revision, {}, 'submit-3'))
      .batch;
    await prisma.roleDeniedPermission.create({
      data: { roleId: 'reviewer', permission: 'payments:approve' },
    });
    await rejects('explicit denial prevents review after submission', () =>
      act(
        'reviewer',
        b.id,
        'review',
        b.revision,
        { decision: 'approve' },
        'denied',
      ),
    );
    await prisma.roleDeniedPermission.delete({
      where: {
        roleId_permission: {
          roleId: 'reviewer',
          permission: 'payments:approve',
        },
      },
    });
    b = (
      await act(
        'reviewer',
        b.id,
        'review',
        b.revision,
        { decision: 'approve', note: 'Checked' },
        'approved',
      )
    ).batch;
    check(
      'independent approval records no paid or verified state',
      b.status === 'approved' &&
        !('paidAt' in b) &&
        (await prisma.payrollObligation.count()) === 1,
    );
    const approvedTotals = JSON.stringify(b.totals);
    const approvedExample = { batch: b };
    await prisma.businessEmployee.update({
      where: { id: 'e' },
      data: { amount: '400000.00', status: 'archived' },
    });
    check(
      'approved historical totals survive source archival',
      JSON.stringify((await read.detail('viewer', 'b', b.id)).batch.totals) ===
        approvedTotals,
    );
    await rejects(
      'approved batches cannot be cancelled',
      () =>
        act(
          'preparer',
          b.id,
          'cancel',
          b.revision,
          { reason: 'Cannot reverse' },
          'cancel-approved',
        ),
      'INVALID_TRANSITION',
    );
    await rejects('database prevents approved batch mutation', () =>
      prisma!.payrollBatch.update({
        where: { id: b.id },
        data: { name: 'tamper', revision: { increment: 1 } },
      }),
    );
    await rejects('database prevents rewriting submitted versions', () =>
      prisma!.payrollHistory.deleteMany({ where: { batchId: b.id } }),
    );
    await prisma.businessEmployee.update({
      where: { id: 'e' },
      data: { status: 'active' },
    });
    const variable = await create('variable-pattern', '12');
    await rejects(
      'changing an approved annual pattern requires cumulative reconciliation',
      () =>
        act('preparer', variable.batch.id, 'submit', 1, {}, 'variable-submit'),
      'YTD_RECONCILIATION_REQUIRED',
    );
    await prisma.businessEmployee.update({
      where: { id: 'e' },
      data: { amount: '350000.00' },
    });
    const first = await create('parallel-1', '11'),
      second = await create('parallel-2', '11');
    const concurrent = await Promise.allSettled([
      act('preparer', first.batch.id, 'submit', 1, {}, 'parallel-submit-1'),
      act('preparer', second.batch.id, 'submit', 1, {}, 'parallel-submit-2'),
    ]);
    check(
      'concurrent overlapping submissions have exactly one winner',
      concurrent.filter((r) => r.status === 'fulfilled').length === 1,
    );
    const loser = concurrent.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    check(
      'conflict identifies duplicate payroll',
      loser.reason instanceof HttpException &&
        (loser.reason.getResponse() as any).code === 'DUPLICATE_PAYROLL',
    );
    const winner = (
      concurrent.find(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<any>
    ).value.batch;
    const draftLoser =
      winner.id === first.batch.id ? second.batch : first.batch;
    await rejects(
      'database exclusion protects overlapping obligations outside the API',
      () =>
        prisma!.payrollObligation.create({
          data: {
            businessId: 'b',
            batchId: draftLoser.id,
            employeeId: 'e',
            periodStart: new Date('2026-11-01'),
            periodEnd: new Date('2026-11-30'),
          },
        }),
    );
    await act(
      'preparer',
      winner.id,
      'cancel',
      winner.revision,
      { reason: 'Replacement draft' },
      'cancel',
    );
    check(
      'cancel releases obligation for replacement',
      (await act('preparer', draftLoser.id, 'submit', 1, {}, 'replacement'))
        .batch.status === 'submitted',
    );
    const incomplete = await create('incomplete', '12', ['incomplete']);
    check(
      'incomplete recipients persist with null totals and explicit blockers',
      incomplete.batch.totals === null &&
        incomplete.batch.blockers.some(
          (b: any) => b.code === 'COMPENSATION_REQUIRED',
        ),
    );
    await rejects(
      'incomplete draft cannot submit',
      () =>
        act(
          'preparer',
          incomplete.batch.id,
          'submit',
          1,
          {},
          'incomplete-submit',
        ),
      'PAYROLL_NOT_READY',
    );
    const zero = await create('zero', '12', ['zero']);
    check(
      'explicit zero is ready with an explanatory no-transfer warning',
      zero.batch.totals.netAmount === '0.00' &&
        (
          await read.recipients(
            'viewer',
            'b',
            zero.batch.id,
            new PayrollRecipientsDto(),
          )
        ).items[0].warnings.some((w) => w.code === 'ZERO_NET_NO_TRANSFER'),
    );
    const list = await read.list(
      'viewer',
      'b',
      Object.assign(new PayrollListDto(), { limit: 1 }),
    );
    check(
      'list totals cover all filtered records and support signed pagination',
      list.items.length === 1 &&
        !!list.nextCursor &&
        list.summary.approvedCount === 1 &&
        list.summary.draftCount >= 2,
    );
    await rejects('cursor cannot be reused with changed filters', () =>
      read.list(
        'viewer',
        'b',
        Object.assign(new PayrollListDto(), {
          cursor: list.nextCursor,
          status: 'draft',
        }),
      ),
    );
    const payDateDraft = await create('pay-date-policy', '12', ['zero']);
    const nextYear = await act('preparer', payDateDraft.batch.id, 'patch', 1, {
      payDate: '2027-01-01',
    });
    check(
      'pay-date changes recalculate policy applicability without refreshing sources',
      nextYear.batch.totals === null &&
        nextYear.batch.blockers.some(
          (b: any) => b.code === 'CALCULATION_POLICY_MISSING',
        ),
    );
    const restoredDate = await act(
      'preparer',
      payDateDraft.batch.id,
      'patch',
      nextYear.batch.revision,
      { payDate: '2026-12-31' },
    );
    check(
      'restoring supported pay-date recalculates the existing snapshot',
      restoredDate.batch.totals.netAmount === '0.00',
    );
    const audit = await prisma.auditEvent.findMany({
      where: { eventType: { startsWith: 'business.payroll.' } },
      select: { metadata: true, changes: true },
    });
    const privateText = JSON.stringify(audit);
    check(
      'general audits contain no salary, bank or tax values',
      audit.length > 10 &&
        !privateText.includes('350000') &&
        !privateText.includes('0012345678') &&
        !privateText.includes('TEST-TIN') &&
        !privateText.includes('1000.00'),
    );
    const vr = (
      await read.recipients(
        'viewer',
        'b',
        variable.batch.id,
        new PayrollRecipientsDto(),
      )
    ).items[0];
    await rejects(
      'mixed membership edit rolls back removals when an added employee is foreign',
      () =>
        act('preparer', variable.batch.id, 'patch', 1, {
          removeRecipientIds: [vr.id],
          addEmployeeIds: ['foreign-e'],
        }),
      'EMPLOYEE_NOT_FOUND',
    );
    check(
      'failed membership edit preserves recipient and revision',
      !(
        await prisma.payrollRecipient.findUniqueOrThrow({
          where: { id: vr.id },
        })
      ).removed &&
        (await read.detail('viewer', 'b', variable.batch.id)).batch.revision ===
          1,
    );
    for (const roleId of ['reviewer', 'editor'])
      await prisma.roleDeniedPermission.create({
        data: { roleId, permission: 'payments:approve' },
      });
    await rejects(
      'submission requires an available independent approver',
      () => act('preparer', zero.batch.id, 'submit', 1, {}, 'zero-submit'),
      'INDEPENDENT_APPROVER_REQUIRED',
    );
    for (const roleId of ['reviewer', 'editor'])
      await prisma.roleDeniedPermission.delete({
        where: {
          roleId_permission: { roleId, permission: 'payments:approve' },
        },
      });
    const submittedZero = (
      await act('preparer', zero.batch.id, 'submit', 1, {}, 'zero-submit')
    ).batch;
    await rejects(
      'database refuses review without an attributed reviewer',
      () =>
        prisma!.payrollBatch.update({
          where: { id: submittedZero.id },
          data: {
            status: 'approved',
            revision: { increment: 1 },
            reviewedBy: Prisma.JsonNull,
          },
        }),
    );
    const reviews = await Promise.allSettled([
      act(
        'reviewer',
        submittedZero.id,
        'review',
        submittedZero.revision,
        { decision: 'approve' },
        'zero-review-a',
      ),
      act(
        'reviewer',
        submittedZero.id,
        'review',
        submittedZero.revision,
        { decision: 'approve' },
        'zero-review-b',
      ),
    ]);
    check(
      'concurrent stale reviews record one approval and one notification',
      reviews.filter((x) => x.status === 'fulfilled').length === 1 &&
        (await prisma.userNotification.count({
          where: {
            type: 'payroll_approved',
            data: { path: ['batchId'], equals: zero.batch.id },
          },
        })) === 1,
    );
    await prisma.user.update({
      where: { id: 'viewer' },
      data: { status: 'suspended' },
    });
    await rejects(
      'inactive account loses access',
      () => read.list('viewer', 'b', new PayrollListDto()),
      'AUTHENTICATION_REQUIRED',
    );
    await mkdir('.tmp', { recursive: true });
    await writeFile(
      '.tmp/payroll-contract-examples.json',
      JSON.stringify(
        {
          readyDraft: draft,
          blockedDraft: incomplete,
          recipient: { recipient: recipients.items[0] },
          submitted: submittedExample,
          approved: approvedExample,
        },
        null,
        2,
      ),
    );
    console.log(`${passed} payroll database checks passed.`);
  } finally {
    await prisma?.$disconnect();
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
