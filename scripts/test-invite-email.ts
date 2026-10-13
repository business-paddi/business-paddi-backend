import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../src/database/prisma.service';
import { seedSystemRoles } from '../src/business-foundation/seed';
import { BusinessAccessService } from '../src/business/business-access.service';
import { InvitePermissionsService } from '../src/business/invite-permissions.service';
import { InviteAcceptanceService } from '../src/business/invite-acceptance.service';
import { InviteService } from '../src/business/invite.service';
import { MemberApprovalService } from '../src/business/member-approval.service';
import { InviteEmailVault } from '../src/invite-email/invite-email-vault.service';
import { InviteEmailOutbox } from '../src/invite-email/invite-email-outbox.service';
import { InviteEmailDeliveryService } from '../src/invite-email/invite-email-delivery.service';
import { InviteEmailQueue } from '../src/invite-email/invite-email-queue.service';
import {
  EmailDeliveryError,
  type InviteEmailProvider,
} from '../src/invite-email/invite-email-provider.service';
import {
  INVITE_EMAIL_QUEUE,
  deliveryJobId,
  SAFE_RETRY_WINDOW_MS,
} from '../src/invite-email/invite-email.constants';
import type { InvitationEmailPayload } from '../src/invite-email/invitation-email.template';
import { databaseErrorSummary } from './database-error';

async function main() {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL)
    throw new Error('DATABASE_URL and REDIS_URL are required');
  const suffix = randomBytes(8).toString('hex');
  const schema = `invite_test_${suffix}`;
  const admin = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30000,
  });
  let pool: Pool | undefined;
  let prisma: PrismaClient | undefined;
  let queue: Queue | undefined;
  let worker: InviteEmailQueue | undefined;
  let created = false;
  let passed = 0;
  const check = (label: string, condition: unknown) => {
    assert.ok(condition, label);
    passed++;
    console.log(`PASS: ${label}`);
  };
  const rejects = async (label: string, operation: () => Promise<unknown>) => {
    await assert.rejects(operation);
    check(label, true);
  };
  try {
    console.log(
      'Creating isolated schema; email provider is fake. Public users and mail are untouched.',
    );
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const url = new URL(process.env.DATABASE_URL);
    url.hostname = url.hostname.replace('-pooler.', '.');
    const scoped = {
      connectionString: url.toString(),
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 30000,
    };
    pool = new Pool(scoped);
    assert.equal(
      (await pool.query('SELECT current_schema() AS schema')).rows[0].schema,
      schema,
    );
    for (const migration of (
      await readdir('prisma/migrations', { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      let sql = await readFile(
        `prisma/migrations/${migration.name}/migration.sql`,
        'utf8',
      );
      sql = sql.replace('CREATE SCHEMA IF NOT EXISTS "public";', '');
      const enumAddition = sql.match(
        /^ALTER TYPE "BusinessMemberStatus" ADD VALUE IF NOT EXISTS 'pending_approval';/,
      );
      if (enumAddition) {
        await pool.query(enumAddition[0]);
        sql = sql.slice(enumAddition[0].length);
      }
      await pool.query(sql);
    }
    console.log(
      'Isolated schema migrated; initializing protected role fixtures...',
    );
    prisma = new PrismaClient({
      adapter: new PrismaPg(scoped, { schema }),
      transactionOptions: { maxWait: 30000, timeout: 60000 },
    });
    const db = prisma as unknown as PrismaService;
    await prisma.$transaction((tx) => seedSystemRoles(tx), {
      maxWait: 30000,
      timeout: 60000,
    });
    const config = new ConfigService({
      FRONTEND_URL: 'https://example.invalid',
      RESEND_FROM_EMAIL: 'BusinessPaddi <test@example.invalid>',
      VERIFICATION_CODE_PEPPER: 'test-only-'.repeat(8),
      REDIS_URL: process.env.REDIS_URL,
      INVITE_EMAIL_QUEUE_PREFIX: schema,
    });
    const vault = new InviteEmailVault(config);
    const outbox = new InviteEmailOutbox(config, vault);
    const policy = new InvitePermissionsService();
    const access = new BusinessAccessService(db);
    const acceptance = new InviteAcceptanceService(db, access, policy, outbox);
    const invites = new InviteService(db, access, policy, outbox, acceptance);
    const approvals = new MemberApprovalService(db, access, policy);
    const account = (name: string) =>
      prisma!.user.create({
        data: {
          name,
          email: `${name}-${suffix}@example.invalid`,
          emailVerifiedAt: new Date(),
        },
      });
    const owner = await account('owner');
    const limited = await account('limited');
    const recipient = await account('recipient');
    const business = await prisma.business.create({
      data: { name: 'Invite Test Business' },
    });
    await prisma.businessMember.create({
      data: {
        businessId: business.id,
        userId: owner.id,
        roleId: 'system-role-owner',
      },
    });
    const limitedRole = await prisma.role.create({
      data: {
        name: 'Invitation coordinator',
        key: 'coordinator',
        type: 'custom',
        businessId: business.id,
        permissions: {
          create: [
            { permission: 'members:invite' },
            { permission: 'roles:assign' },
          ],
        },
      },
    });
    await prisma.businessMember.create({
      data: {
        businessId: business.id,
        userId: limited.id,
        roleId: limitedRole.id,
      },
    });
    const targetRole = await prisma.role.create({
      data: {
        name: 'Report reader',
        key: 'report_reader',
        type: 'custom',
        businessId: business.id,
        permissions: { create: [{ permission: 'reports:view' }] },
      },
    });

    await rejects('invite, outbox and notification roll back together', () =>
      prisma!.$transaction(async (tx) => {
        await invites.record(tx, owner.id, business.id, {
          email: 'rollback@example.invalid',
        });
        throw new Error('Test rollback');
      }),
    );
    check(
      'rollback leaves no invitation or durable job',
      (await prisma.businessInvite.count({
        where: { email: 'rollback@example.invalid' },
      })) === 0 && (await prisma.inviteEmailDelivery.count()) === 0,
    );
    const invited = await invites.create(limited.id, business.id, {
      email: recipient.email,
      roleId: targetRole.id,
    });
    check(
      'excess target grants persist approval requirement',
      invited.invitation.requiresApproval,
    );
    const delivery = await prisma.inviteEmailDelivery.findFirstOrThrow({
      where: { inviteId: invited.invitation.id },
    });
    check(
      'email and notification persist without Redis or provider calls',
      delivery.state === 'pending' &&
        !!delivery.payloadCiphertext &&
        (await prisma.userNotification.count({
          where: { inviteId: invited.invitation.id },
        })) === 1,
    );
    const repeated = await Promise.all([
      invites.resend(owner.id, business.id, invited.invitation.id),
      invites.resend(owner.id, business.id, invited.invitation.id),
    ]);
    check(
      'concurrent resend requests reuse the pending delivery',
      repeated.every((item) => item.invitation.deliveryGeneration === 1) &&
        (await prisma.inviteEmailDelivery.count({
          where: { inviteId: invited.invitation.id },
        })) === 1,
    );
    const accepted = await invites.acceptById(
      recipient.id,
      invited.invitation.id,
    );
    check(
      'acceptance creates pending membership with no effective access',
      accepted.membership.status === 'pending_approval' &&
        accepted.membership.approvalStatus === 'pending' &&
        accepted.membership.role.effectivePermissions.length === 0,
    );
    await rejects('pending member cannot enter workspace', () =>
      access.require(recipient.id, business.id),
    );
    await rejects('inviter without target grants cannot approve', () =>
      approvals.review(limited.id, business.id, accepted.membership.id, true),
    );
    await rejects('database rejects bypassing pending approval', () =>
      prisma!.businessMember.update({
        where: { id: accepted.membership.id },
        data: {
          status: 'active',
          approvalStatus: 'not_required',
          statusUpdatedAt: new Date(),
          statusUpdatedByUserId: limited.id,
        },
      }),
    );
    await rejects('database also checks reviewer grant authority', () =>
      prisma!.businessMember.update({
        where: { id: accepted.membership.id },
        data: {
          status: 'active',
          approvalStatus: 'approved',
          approvalReviewedByUserId: limited.id,
          approvalReviewedAt: new Date(),
          statusUpdatedAt: new Date(),
          statusUpdatedByUserId: limited.id,
        },
      }),
    );
    const approved = await approvals.review(
      owner.id,
      business.id,
      accepted.membership.id,
      true,
    );
    check(
      'qualified reviewer grants active access and persists audit fields',
      approved.membership.status === 'active' &&
        approved.membership.approvalReviewedByUserId === owner.id &&
        (await access.require(recipient.id, business.id)).permissions.includes(
          'reports:view',
        ),
    );
    await rejects('review cannot be applied twice', () =>
      approvals.review(owner.id, business.id, accepted.membership.id, true),
    );
    const directUser = await account('direct');
    const directInvite = await invites.create(owner.id, business.id, {
      email: directUser.email,
    });
    const direct = await invites.acceptById(
      directUser.id,
      directInvite.invitation.id,
    );
    check(
      'authorized inviter grants immediate active membership',
      direct.membership.status === 'active' &&
        direct.membership.approvalStatus === 'not_required',
    );
    const rejectedUser = await account('rejected');
    const rejectInvite = await invites.create(limited.id, business.id, {
      email: rejectedUser.email,
      roleId: targetRole.id,
    });
    const rejectMember = await invites.acceptById(
      rejectedUser.id,
      rejectInvite.invitation.id,
    );
    const rejected = await approvals.review(
      owner.id,
      business.id,
      rejectMember.membership.id,
      false,
      'Not authorized for reporting',
    );
    check(
      'rejection persists reason and leaves membership removed',
      rejected.membership.status === 'removed' &&
        rejected.membership.approvalReason === 'Not authorized for reporting',
    );

    const calls: { payload: InvitationEmailPayload; key: string }[] = [];
    const delivered = new Map<string, string>();
    let transient = false;
    const provider = {
      send: async (payload: InvitationEmailPayload, key: string) => {
        calls.push({ payload, key });
        if (transient) {
          transient = false;
          throw new EmailDeliveryError('TEST_RATE_LIMIT', true);
        }
        const id = delivered.get(key) ?? `fake-${delivered.size + 1}`;
        delivered.set(key, id);
        return id;
      },
    } as unknown as InviteEmailProvider;
    const sender = new InviteEmailDeliveryService(db, vault, provider);
    const mailInvite = await invites.create(owner.id, business.id, {
      email: 'mail@example.invalid',
    });
    const mail = await prisma.inviteEmailDelivery.findFirstOrThrow({
      where: { inviteId: mailInvite.invitation.id },
    });
    await Promise.all([sender.deliver(mail.id), sender.deliver(mail.id)]);
    await sender.deliver(mail.id);
    check(
      'concurrent workers and replay produce one provider submission',
      calls.length === 1 &&
        delivered.size === 1 &&
        (
          await prisma.inviteEmailDelivery.findUniqueOrThrow({
            where: { id: mail.id },
          })
        ).state === 'sent',
    );
    await rejects('database prevents resetting a sent delivery', () =>
      prisma!.inviteEmailDelivery.update({
        where: { id: mail.id },
        data: {
          state: 'pending',
          payloadCiphertext: vault.encrypt(mail.id, calls[0].payload),
        },
      }),
    );
    const uncertainInvite = await invites.create(owner.id, business.id, {
      email: 'uncertain@example.invalid',
    });
    const uncertain = await prisma.inviteEmailDelivery.findFirstOrThrow({
      where: { inviteId: uncertainInvite.invitation.id },
    });
    await prisma.inviteEmailDelivery.update({
      where: { id: uncertain.id },
      data: {
        attempts: 1,
        firstAttemptAt: new Date(Date.now() - SAFE_RETRY_WINDOW_MS - 1000),
      },
    });
    await sender.deliver(uncertain.id);
    check(
      'old ambiguous delivery is persisted as uncertain without another send',
      (
        await prisma.inviteEmailDelivery.findUniqueOrThrow({
          where: { id: uncertain.id },
        })
      ).state === 'uncertain' && calls.length === 1,
    );
    await rejects(
      'manual resend is blocked until uncertain delivery is reconciled',
      () =>
        invites.resend(owner.id, business.id, uncertainInvite.invitation.id),
    );

    const queuedInvite = await invites.create(owner.id, business.id, {
      email: 'queue@example.invalid',
    });
    const queued = await prisma.inviteEmailDelivery.findFirstOrThrow({
      where: { inviteId: queuedInvite.invitation.id },
    });
    const redis = new URL(process.env.REDIS_URL);
    const connection = {
      host: redis.hostname,
      port: Number(redis.port || 6379),
      password: decodeURIComponent(redis.password) || undefined,
      username: decodeURIComponent(redis.username) || undefined,
      db: Number(redis.pathname.slice(1) || 0),
      ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
    };
    queue = new Queue(INVITE_EMAIL_QUEUE, { prefix: schema, connection });
    await queue.waitUntilReady();
    transient = true;
    worker = new InviteEmailQueue(config, db, sender);
    worker.onModuleInit();
    await worker.relay();
    const waitFor = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Queue integration timeout');
    };
    await waitFor(async () => {
      const current = await prisma!.inviteEmailDelivery.findUniqueOrThrow({
        where: { id: queued.id },
      });
      return current.attempts === 1 && current.state === 'pending';
    });
    check(
      'BullMQ records transient send failure in PostgreSQL',
      (
        await prisma.inviteEmailDelivery.findUniqueOrThrow({
          where: { id: queued.id },
        })
      ).state === 'pending',
    );
    await prisma.inviteEmailDelivery.update({
      where: { id: queued.id },
      data: { nextAttemptAt: new Date(0) },
    });
    const job = await queue.getJob(deliveryJobId(queued.id));
    assert.ok(job);
    if ((await job.getState()) === 'delayed') await job.promote();
    await worker.relay();
    await waitFor(
      async () =>
        (
          await prisma!.inviteEmailDelivery.findUniqueOrThrow({
            where: { id: queued.id },
          })
        ).state === 'sent',
    );
    const attempts = calls.filter(
      (call) => call.key === `business-invite/${queued.id}`,
    );
    check(
      'real BullMQ retry sends exactly the same body and provider key',
      attempts.length === 2 &&
        JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]),
    );
    check(
      'queued job contains only an opaque delivery ID',
      Object.keys(job.data).join(',') === 'deliveryId',
    );
    console.log(`${passed} invite database and BullMQ checks passed.`);
  } finally {
    await worker?.onModuleDestroy();
    if (queue) {
      assert.equal(queue.opts.prefix, schema);
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await prisma?.$disconnect();
    await pool?.end();
    if (created) {
      assert.match(schema, /^invite_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      console.log('Isolated schema and queue removed.');
    }
    await admin.end();
  }
}
void main().catch((error) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
