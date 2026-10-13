ALTER TYPE "BusinessMemberStatus" ADD VALUE IF NOT EXISTS 'pending_approval';

BEGIN;
-- CreateEnum
CREATE TYPE "MemberApprovalStatus" AS ENUM ('not_required', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "InviteEmailState" AS ENUM ('pending', 'processing', 'sent', 'failed', 'cancelled', 'uncertain');

-- AlterEnum


-- AlterTable
ALTER TABLE "BusinessMember" ADD COLUMN     "approvalReason" VARCHAR(500),
ADD COLUMN     "approvalRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "approvalReviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "approvalReviewedByUserId" TEXT,
ADD COLUMN     "approvalStatus" "MemberApprovalStatus" NOT NULL DEFAULT 'not_required';

-- AlterTable
ALTER TABLE "BusinessInvite" ADD COLUMN     "deliveryGeneration" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "deliveryLastError" VARCHAR(100),
ADD COLUMN     "deliveryProviderId" TEXT,
ADD COLUMN     "deliverySentAt" TIMESTAMPTZ(3),
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "InviteEmailDelivery" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "state" "InviteEmailState" NOT NULL DEFAULT 'pending',
    "payloadCiphertext" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptAt" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "providerId" TEXT,
    "lastError" VARCHAR(100),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InviteEmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InviteEmailDelivery_state_nextAttemptAt_idx" ON "InviteEmailDelivery"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InviteEmailDelivery_state_leaseExpiresAt_idx" ON "InviteEmailDelivery"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InviteEmailDelivery_inviteId_generation_key" ON "InviteEmailDelivery"("inviteId", "generation");

-- CreateIndex
CREATE INDEX "BusinessMember_businessId_approvalStatus_approvalRequestedA_idx" ON "BusinessMember"("businessId", "approvalStatus", "approvalRequestedAt");

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_approvalReviewedByUserId_fkey" FOREIGN KEY ("approvalReviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InviteEmailDelivery" ADD CONSTRAINT "InviteEmailDelivery_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "BusinessInvite"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_approval_check" CHECK (
  ("status" = 'pending_approval') = ("approvalStatus" = 'pending') AND
  ("approvalStatus" <> 'pending' OR "approvalRequestedAt" IS NOT NULL) AND
  ("approvalStatus" NOT IN ('approved', 'rejected') OR ("approvalReviewedAt" IS NOT NULL AND "approvalReviewedByUserId" IS NOT NULL)) AND
  ("approvalStatus" <> 'rejected' OR "status" = 'removed')
);
ALTER TABLE "BusinessInvite" ADD CONSTRAINT "BusinessInvite_delivery_generation_check" CHECK ("deliveryGeneration" > 0);
ALTER TABLE "InviteEmailDelivery" ADD CONSTRAINT "InviteEmailDelivery_state_check" CHECK (
  "generation" > 0 AND "attempts" BETWEEN 0 AND 6 AND
  ("attempts" = 0 OR "firstAttemptAt" IS NOT NULL) AND
  (("state" = 'processing') = ("leaseId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)) AND
  ("state" NOT IN ('pending', 'processing') OR "payloadCiphertext" LIKE 'v1.%') AND
  ("state" <> 'sent' OR ("sentAt" IS NOT NULL AND "providerId" IS NOT NULL))
);

CREATE FUNCTION protect_invite_email_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Invite email delivery history must be retained'; END IF;
  IF NEW."inviteId" IS DISTINCT FROM OLD."inviteId" OR NEW."generation" IS DISTINCT FROM OLD."generation" OR NEW."id" IS DISTINCT FROM OLD."id" THEN RAISE EXCEPTION 'Invite delivery identity is immutable'; END IF;
  IF NEW."payloadCiphertext" IS DISTINCT FROM OLD."payloadCiphertext" AND NOT (NEW."payloadCiphertext" IS NULL AND NEW."state" IN ('sent', 'cancelled')) THEN RAISE EXCEPTION 'Invite delivery payload is immutable'; END IF;
  IF OLD."state" IN ('sent', 'cancelled', 'failed', 'uncertain') AND NEW."state" IS DISTINCT FROM OLD."state" THEN RAISE EXCEPTION 'Terminal invite deliveries cannot be sent again'; END IF;
  IF NEW."attempts" < OLD."attempts" OR OLD."firstAttemptAt" IS NOT NULL AND NEW."firstAttemptAt" IS DISTINCT FROM OLD."firstAttemptAt" THEN RAISE EXCEPTION 'Invite delivery retry history cannot be reset'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "InviteEmailDelivery_history_guard" BEFORE UPDATE OR DELETE ON "InviteEmailDelivery" FOR EACH ROW EXECUTE FUNCTION protect_invite_email_delivery();

CREATE FUNCTION enforce_member_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reviewer_role TEXT;
BEGIN
  IF OLD."approvalStatus" = 'pending' AND NEW."approvalStatus" <> 'pending' THEN
    IF NEW."approvalStatus" NOT IN ('approved', 'rejected') OR NEW."approvalReviewedByUserId" IS NULL OR NEW."approvalReviewedByUserId" = NEW."userId" THEN RAISE EXCEPTION 'Pending membership requires an independent review'; END IF;
    SELECT m."roleId" INTO reviewer_role FROM "BusinessMember" m JOIN "Role" r ON r."id" = m."roleId" JOIN "Business" b ON b."id" = m."businessId"
      WHERE m."businessId" = NEW."businessId" AND m."userId" = NEW."approvalReviewedByUserId" AND m."status" = 'active' AND r."status" = 'active' AND b."status" = 'active' FOR SHARE OF m, r, b;
    IF reviewer_role IS NULL OR NOT EXISTS (SELECT 1 FROM "RolePermission" p WHERE p."roleId" = reviewer_role AND p."permission" = 'roles:assign') OR EXISTS (SELECT 1 FROM "RoleDeniedPermission" d WHERE d."roleId" = reviewer_role AND d."permission" = 'roles:assign') THEN RAISE EXCEPTION 'Reviewer requires roles:assign'; END IF;
    IF EXISTS (
      SELECT 1 FROM "RolePermission" target WHERE target."roleId" = NEW."roleId"
      AND NOT EXISTS (SELECT 1 FROM "RoleDeniedPermission" denied WHERE denied."roleId" = NEW."roleId" AND denied."permission" = target."permission")
      AND (NOT EXISTS (SELECT 1 FROM "RolePermission" p WHERE p."roleId" = reviewer_role AND p."permission" = target."permission") OR EXISTS (SELECT 1 FROM "RoleDeniedPermission" d WHERE d."roleId" = reviewer_role AND d."permission" = target."permission"))
    ) THEN RAISE EXCEPTION 'Reviewer cannot assign permissions they do not possess'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BusinessMember_approval_guard" BEFORE UPDATE ON "BusinessMember" FOR EACH ROW EXECUTE FUNCTION enforce_member_approval();
COMMIT;
