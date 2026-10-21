BEGIN;
-- CreateEnum
CREATE TYPE "ReferralCodeStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "ReferralPlan" AS ENUM ('starter', 'growth', 'standard', 'efficient');

-- CreateEnum
CREATE TYPE "ReferralBillingMode" AS ENUM ('monthly', 'annually');

-- CreateEnum
CREATE TYPE "ReferralEarningStatus" AS ENUM ('pending', 'available', 'paid', 'reversed');

-- CreateEnum
CREATE TYPE "ReferralEligibility" AS ENUM ('pending_review', 'eligible', 'ineligible');

-- CreateEnum
CREATE TYPE "ReferralWebhookStatus" AS ENUM ('pending', 'processed', 'quarantined');

-- CreateEnum
CREATE TYPE "ReferralLedgerKind" AS ENUM ('credit', 'reversal', 'availability', 'payout');

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "status" "ReferralCodeStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCustomer" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "eligibility" "ReferralEligibility" NOT NULL DEFAULT 'pending_review',
    "firstPaidPaymentKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralBillingIdentity" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "providerCustomerId" VARCHAR(200) NOT NULL,
    "customerId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralBillingIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralAttribution" (
    "id" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "attributedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifyingPaymentId" TEXT,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanSelection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "planKey" "ReferralPlan" NOT NULL,
    "billingMode" "ReferralBillingMode" NOT NULL,
    "referralAttributionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlanSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralPayment" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "providerPaymentId" VARCHAR(200) NOT NULL,
    "customerId" TEXT NOT NULL,
    "planKey" "ReferralPlan" NOT NULL,
    "billingMode" "ReferralBillingMode" NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "settledSubtotalMinor" BIGINT NOT NULL,
    "refundedSubtotalMinor" BIGINT NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralEarning" (
    "id" TEXT NOT NULL,
    "attributionId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "eligibleAmountMinor" BIGINT NOT NULL,
    "rateBps" INTEGER NOT NULL DEFAULT 1000,
    "commissionMinor" BIGINT NOT NULL,
    "reversedMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "ReferralEarningStatus" NOT NULL DEFAULT 'pending',
    "availableAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralLedgerEntry" (
    "id" TEXT NOT NULL,
    "earningId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "idempotencyKey" VARCHAR(300) NOT NULL,
    "kind" "ReferralLedgerKind" NOT NULL,
    "pendingDelta" BIGINT NOT NULL DEFAULT 0,
    "availableDelta" BIGINT NOT NULL DEFAULT 0,
    "paidDelta" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "eventId" VARCHAR(200) NOT NULL,
    "payloadDigest" VARCHAR(64) NOT NULL,
    "providerPaymentId" VARCHAR(200) NOT NULL,
    "cumulativeRefundMinor" BIGINT,
    "status" "ReferralWebhookStatus" NOT NULL DEFAULT 'pending',
    "processedAt" TIMESTAMPTZ(3),
    "errorCode" VARCHAR(60),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralAudit" (
    "id" TEXT NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "actorUserId" TEXT,
    "subjectUserId" TEXT NOT NULL,
    "referrerUserId" TEXT,
    "referredUserId" TEXT,
    "customerId" TEXT,
    "businessId" TEXT,
    "referralCodeId" TEXT,
    "attributionId" TEXT,
    "earningId" TEXT,
    "paymentId" TEXT,
    "requestId" VARCHAR(100),
    "correlationId" VARCHAR(300),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_ownerUserId_key" ON "ReferralCode"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_tokenHash_key" ON "ReferralCode"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_id_ownerUserId_key" ON "ReferralCode"("id", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCustomer_ownerUserId_key" ON "ReferralCustomer"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCustomer_firstPaidPaymentKey_key" ON "ReferralCustomer"("firstPaidPaymentKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCustomer_id_ownerUserId_key" ON "ReferralCustomer"("id", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralBillingIdentity_businessId_key" ON "ReferralBillingIdentity"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralBillingIdentity_provider_providerCustomerId_key" ON "ReferralBillingIdentity"("provider", "providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_customerId_key" ON "ReferralAttribution"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_qualifyingPaymentId_key" ON "ReferralAttribution"("qualifyingPaymentId");

-- CreateIndex
CREATE INDEX "ReferralAttribution_referrerUserId_attributedAt_id_idx" ON "ReferralAttribution"("referrerUserId", "attributedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_id_customerId_key" ON "ReferralAttribution"("id", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_customerId_referredUserId_key" ON "ReferralAttribution"("customerId", "referredUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_id_referrerUserId_customerId_key" ON "ReferralAttribution"("id", "referrerUserId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanSelection_userId_key" ON "PlanSelection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanSelection_customerId_key" ON "PlanSelection"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanSelection_referralAttributionId_key" ON "PlanSelection"("referralAttributionId");

-- CreateIndex
CREATE INDEX "ReferralPayment_customerId_settledAt_id_idx" ON "ReferralPayment"("customerId", "settledAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralPayment_provider_providerPaymentId_key" ON "ReferralPayment"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEarning_attributionId_key" ON "ReferralEarning"("attributionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEarning_customerId_key" ON "ReferralEarning"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEarning_paymentId_key" ON "ReferralEarning"("paymentId");

-- CreateIndex
CREATE INDEX "ReferralEarning_referrerUserId_createdAt_id_idx" ON "ReferralEarning"("referrerUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEarning_id_referrerUserId_currency_key" ON "ReferralEarning"("id", "referrerUserId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEarning_attributionId_referrerUserId_customerId_key" ON "ReferralEarning"("attributionId", "referrerUserId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralLedgerEntry_idempotencyKey_key" ON "ReferralLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReferralLedgerEntry_referrerUserId_currency_idx" ON "ReferralLedgerEntry"("referrerUserId", "currency");

-- CreateIndex
CREATE INDEX "ReferralLedgerEntry_earningId_createdAt_id_idx" ON "ReferralLedgerEntry"("earningId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ReferralWebhookEvent_provider_providerPaymentId_status_idx" ON "ReferralWebhookEvent"("provider", "providerPaymentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralWebhookEvent_provider_eventId_key" ON "ReferralWebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "ReferralAudit_subjectUserId_createdAt_id_idx" ON "ReferralAudit"("subjectUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReferralAudit_referrerUserId_createdAt_id_idx" ON "ReferralAudit"("referrerUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReferralAudit_referredUserId_createdAt_id_idx" ON "ReferralAudit"("referredUserId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReferralAudit_eventType_createdAt_id_idx" ON "ReferralAudit"("eventType", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReferralAudit_paymentId_idx" ON "ReferralAudit"("paymentId");

-- CreateIndex
CREATE INDEX "ReferralAudit_earningId_idx" ON "ReferralAudit"("earningId");

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCustomer" ADD CONSTRAINT "ReferralCustomer_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralBillingIdentity" ADD CONSTRAINT "ReferralBillingIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ReferralCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralBillingIdentity" ADD CONSTRAINT "ReferralBillingIdentity_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_referralCodeId_referrerUserId_fkey" FOREIGN KEY ("referralCodeId", "referrerUserId") REFERENCES "ReferralCode"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_customerId_referredUserId_fkey" FOREIGN KEY ("customerId", "referredUserId") REFERENCES "ReferralCustomer"("id", "ownerUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_qualifyingPaymentId_fkey" FOREIGN KEY ("qualifyingPaymentId") REFERENCES "ReferralPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanSelection" ADD CONSTRAINT "PlanSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanSelection" ADD CONSTRAINT "PlanSelection_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ReferralCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanSelection" ADD CONSTRAINT "PlanSelection_referralAttributionId_fkey" FOREIGN KEY ("referralAttributionId") REFERENCES "ReferralAttribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralPayment" ADD CONSTRAINT "ReferralPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ReferralCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_attributionId_referrerUserId_customerId_fkey" FOREIGN KEY ("attributionId", "referrerUserId", "customerId") REFERENCES "ReferralAttribution"("id", "referrerUserId", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "ReferralCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ReferralPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralLedgerEntry" ADD CONSTRAINT "ReferralLedgerEntry_earningId_referrerUserId_currency_fkey" FOREIGN KEY ("earningId", "referrerUserId", "currency") REFERENCES "ReferralEarning"("id", "referrerUserId", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReferralAudit" ADD CONSTRAINT "ReferralAudit_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- No historical customer attribution, subscription activation, or reward backfill.
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_hash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_not_self" CHECK ("referrerUserId" <> "referredUserId");
ALTER TABLE "PlanSelection" ADD CONSTRAINT "PlanSelection_no_custom_quote" CHECK ("planKey" <> 'efficient');
ALTER TABLE "ReferralPayment" ADD CONSTRAINT "ReferralPayment_amount_check" CHECK (
 "currency" IN ('USD', 'NGN') AND "settledSubtotalMinor" BETWEEN 0 AND 9007199254740991 AND
 "refundedSubtotalMinor" BETWEEN 0 AND "settledSubtotalMinor" AND "planKey" IN ('growth','standard'));
ALTER TABLE "ReferralEarning" ADD CONSTRAINT "ReferralEarning_amount_check" CHECK (
 "currency" IN ('USD','NGN') AND "eligibleAmountMinor" BETWEEN 1 AND 9007199254740991 AND "rateBps" = 1000 AND
 "commissionMinor" = floor(("eligibleAmountMinor"::numeric * 1000 + 5000) / 10000) AND
 "commissionMinor" > 0 AND "reversedMinor" BETWEEN 0 AND "commissionMinor" AND
 ("status" <> 'reversed' OR "reversedMinor" = "commissionMinor") AND
 ("status" <> 'available' OR "availableAt" IS NOT NULL) AND ("status" <> 'paid' OR "paidAt" IS NOT NULL));
ALTER TABLE "ReferralWebhookEvent" ADD CONSTRAINT "ReferralWebhookEvent_digest_check" CHECK (
 "payloadDigest" ~ '^[a-f0-9]{64}$' AND ("cumulativeRefundMinor" IS NULL OR "cumulativeRefundMinor" BETWEEN 0 AND 9007199254740991));
ALTER TABLE "ReferralLedgerEntry" ADD CONSTRAINT "ReferralLedgerEntry_direction_check" CHECK (
 "pendingDelta" BETWEEN -9007199254740991 AND 9007199254740991 AND "availableDelta" BETWEEN -9007199254740991 AND 9007199254740991 AND "paidDelta" BETWEEN 0 AND 9007199254740991 AND
 CASE "kind"
 WHEN 'credit' THEN "pendingDelta" > 0 AND "availableDelta" = 0 AND "paidDelta" = 0
 WHEN 'reversal' THEN "pendingDelta" <= 0 AND "availableDelta" <= 0 AND "pendingDelta" + "availableDelta" < 0 AND "paidDelta" = 0
 WHEN 'availability' THEN "pendingDelta" < 0 AND "availableDelta" = -"pendingDelta" AND "paidDelta" = 0
 WHEN 'payout' THEN "pendingDelta" = 0 AND "availableDelta" < 0 AND "paidDelta" = -"availableDelta"
 END);
ALTER TABLE "ReferralAudit" ADD CONSTRAINT "ReferralAudit_metadata_allowlist" CHECK (
 jsonb_typeof("metadata") = 'object' AND
 "metadata" - ARRAY['plan','mode','reason','currency','amountMinor','commissionMinor','reversedMinor','status']::text[] = '{}'::jsonb);

CREATE FUNCTION referral_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Referral audit and ledger rows are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER referral_audit_append_only BEFORE UPDATE OR DELETE ON "ReferralAudit" FOR EACH ROW EXECUTE FUNCTION referral_append_only();
CREATE TRIGGER referral_ledger_append_only BEFORE UPDATE OR DELETE ON "ReferralLedgerEntry" FOR EACH ROW EXECUTE FUNCTION referral_append_only();

CREATE FUNCTION referral_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Referral identities cannot be deleted' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW."qualifyingPaymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReferralPayment" p WHERE p."id" = NEW."qualifyingPaymentId" AND p."customerId" = NEW."customerId") THEN RAISE EXCEPTION 'Qualifying payment belongs to another customer' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME = 'ReferralCode' THEN
  IF ROW(OLD."ownerUserId", OLD."tokenHash", OLD."encryptedToken", OLD."createdAt") IS DISTINCT FROM ROW(NEW."ownerUserId", NEW."tokenHash", NEW."encryptedToken", NEW."createdAt") THEN
   RAISE EXCEPTION 'Referral code identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
   INSERT INTO "ReferralAudit" ("id","eventType","subjectUserId","referrerUserId","referralCodeId","metadata") VALUES (gen_random_uuid()::text, 'referral.code_disabled', NEW."ownerUserId", NEW."ownerUserId", NEW."id", jsonb_build_object('status',NEW."status"));
  END IF;
 ELSIF TG_TABLE_NAME = 'ReferralAttribution' THEN
  IF ROW(OLD."referralCodeId",OLD."referrerUserId",OLD."customerId",OLD."referredUserId",OLD."attributedAt") IS DISTINCT FROM ROW(NEW."referralCodeId",NEW."referrerUserId",NEW."customerId",NEW."referredUserId",NEW."attributedAt") OR (OLD."qualifyingPaymentId" IS NOT NULL AND OLD."qualifyingPaymentId" IS DISTINCT FROM NEW."qualifyingPaymentId") THEN
   RAISE EXCEPTION 'The first valid attribution is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."qualifyingPaymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReferralPayment" p WHERE p."id" = NEW."qualifyingPaymentId" AND p."customerId" = NEW."customerId") THEN RAISE EXCEPTION 'Qualifying payment belongs to another customer' USING ERRCODE = '23514'; END IF;
 ELSIF TG_TABLE_NAME = 'ReferralCustomer' THEN
  IF OLD."ownerUserId" <> NEW."ownerUserId" OR (OLD."firstPaidPaymentKey" IS NOT NULL AND OLD."firstPaidPaymentKey" IS DISTINCT FROM NEW."firstPaidPaymentKey") THEN RAISE EXCEPTION 'Customer payment identity is immutable' USING ERRCODE = '23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_code_immutable BEFORE UPDATE OR DELETE ON "ReferralCode" FOR EACH ROW EXECUTE FUNCTION referral_immutable_identity();
CREATE TRIGGER referral_attribution_immutable BEFORE INSERT OR UPDATE OR DELETE ON "ReferralAttribution" FOR EACH ROW EXECUTE FUNCTION referral_immutable_identity();
CREATE TRIGGER referral_customer_immutable BEFORE UPDATE OR DELETE ON "ReferralCustomer" FOR EACH ROW EXECUTE FUNCTION referral_immutable_identity();

CREATE FUNCTION referral_selection_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ReferralCustomer" c WHERE c."id" = NEW."customerId" AND c."ownerUserId" = NEW."userId") OR
 (NEW."referralAttributionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ReferralAttribution" a WHERE a."id" = NEW."referralAttributionId" AND a."customerId" = NEW."customerId")) THEN RAISE EXCEPTION 'Plan selection customer mismatch' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' AND ROW(OLD."userId",OLD."customerId") IS DISTINCT FROM ROW(NEW."userId",NEW."customerId") THEN RAISE EXCEPTION 'Selection account identity is immutable' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_selection_scope BEFORE INSERT OR UPDATE ON "PlanSelection" FOR EACH ROW EXECUTE FUNCTION referral_selection_scope();

CREATE FUNCTION referral_earning_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ReferralPayment" p JOIN "ReferralAttribution" a ON a."qualifyingPaymentId" = p."id" WHERE a."id" = NEW."attributionId" AND p."id" = NEW."paymentId" AND p."customerId" = NEW."customerId" AND p."currency" = NEW."currency" AND p."settledSubtotalMinor" = NEW."eligibleAmountMinor") THEN RAISE EXCEPTION 'Reward does not match its qualifying payment' USING ERRCODE = '23514'; END IF;
 IF TG_OP = 'UPDATE' THEN
  IF ROW(OLD."attributionId",OLD."referrerUserId",OLD."customerId",OLD."paymentId",OLD."currency",OLD."eligibleAmountMinor",OLD."rateBps",OLD."commissionMinor",OLD."createdAt") IS DISTINCT FROM ROW(NEW."attributionId",NEW."referrerUserId",NEW."customerId",NEW."paymentId",NEW."currency",NEW."eligibleAmountMinor",NEW."rateBps",NEW."commissionMinor",NEW."createdAt") OR NEW."reversedMinor" < OLD."reversedMinor" THEN RAISE EXCEPTION 'Original referral reward is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NOT ((OLD."status" = 'pending' AND NEW."status" IN ('available','reversed')) OR (OLD."status" = 'available' AND NEW."status" IN ('paid','reversed'))) THEN RAISE EXCEPTION 'Invalid reward state transition' USING ERRCODE = '23514'; END IF;
  IF NEW."status" IN ('available','paid') AND OLD."status" IS DISTINCT FROM NEW."status" THEN
   INSERT INTO "ReferralAudit" ("id","eventType","subjectUserId","referrerUserId","customerId","earningId","paymentId","metadata") VALUES (gen_random_uuid()::text, CASE WHEN NEW."status" = 'paid' THEN 'referral.reward_paid' ELSE 'referral.reward_available' END, NEW."referrerUserId",NEW."referrerUserId",NEW."customerId",NEW."id",NEW."paymentId",jsonb_build_object('status',NEW."status"));
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_earning_invariants BEFORE INSERT OR UPDATE ON "ReferralEarning" FOR EACH ROW EXECUTE FUNCTION referral_earning_invariants();
CREATE TRIGGER referral_earning_no_delete BEFORE DELETE ON "ReferralEarning" FOR EACH ROW EXECUTE FUNCTION referral_append_only();

CREATE FUNCTION referral_ledger_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "ReferralEarning"; p numeric; a numeric; d numeric;
BEGIN
 SELECT * INTO e FROM "ReferralEarning" WHERE "id" = NEW."earningId" FOR UPDATE;
 SELECT COALESCE(sum("pendingDelta"),0) + NEW."pendingDelta", COALESCE(sum("availableDelta"),0) + NEW."availableDelta", COALESCE(sum("paidDelta"),0) + NEW."paidDelta" INTO p,a,d FROM "ReferralLedgerEntry" WHERE "earningId" = NEW."earningId";
 IF p < 0 OR a < 0 OR d < 0 OR p+a+d <> e."commissionMinor"-e."reversedMinor" THEN RAISE EXCEPTION 'Referral ledger does not reconcile to its reward' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_ledger_balance BEFORE INSERT ON "ReferralLedgerEntry" FOR EACH ROW EXECUTE FUNCTION referral_ledger_balance();

CREATE FUNCTION referral_payment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Settled payment history cannot be deleted' USING ERRCODE = '23514'; END IF;
 IF ROW(OLD."provider",OLD."providerPaymentId",OLD."customerId",OLD."planKey",OLD."billingMode",OLD."currency",OLD."settledSubtotalMinor",OLD."settledAt") IS DISTINCT FROM ROW(NEW."provider",NEW."providerPaymentId",NEW."customerId",NEW."planKey",NEW."billingMode",NEW."currency",NEW."settledSubtotalMinor",NEW."settledAt") OR NEW."refundedSubtotalMinor" < OLD."refundedSubtotalMinor" THEN RAISE EXCEPTION 'Settled payment facts are immutable' USING ERRCODE = '23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER referral_payment_immutable BEFORE UPDATE OR DELETE ON "ReferralPayment" FOR EACH ROW EXECUTE FUNCTION referral_payment_immutable();
CREATE TRIGGER referral_billing_identity_immutable BEFORE UPDATE OR DELETE ON "ReferralBillingIdentity" FOR EACH ROW EXECUTE FUNCTION referral_append_only();

COMMIT;
