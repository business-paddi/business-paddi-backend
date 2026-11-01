BEGIN;
-- CreateTable
CREATE TABLE "PayrollPayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "merchantReference" VARCHAR(80) NOT NULL,
    "remitaRRR" VARCHAR(40),
    "state" VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    "providerStatus" VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
    "settlementStatus" VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
    "totalNetSalaryKobo" BIGINT NOT NULL,
    "platformFeeKobo" BIGINT NOT NULL,
    "providerFeeKobo" BIGINT,
    "totalInvoiceKobo" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" CHAR(64) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "requestKey" VARCHAR(100) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "providerCode" VARCHAR(80),
    "verifiedAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "checkToken" TEXT,
    "reconcileRequestedAt" TIMESTAMPTZ(3),
    "lastSignalHash" CHAR(64),
    "lastSignalAt" TIMESTAMPTZ(3),
    "mockScenario" VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
    "recipientEvidence" JSONB NOT NULL DEFAULT '[]',
    "lastErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollMockEvent" (
    "businessId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "eventId" VARCHAR(80) NOT NULL,
    "scenario" VARCHAR(30) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollMockEvent_pkey" PRIMARY KEY ("paymentId","eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_merchantReference_key" ON "PayrollPayment"("merchantReference");

-- CreateIndex
CREATE INDEX "PayrollPayment_businessId_batchId_createdAt_idx" ON "PayrollPayment"("businessId", "batchId", "createdAt");

-- CreateIndex
CREATE INDEX "PayrollPayment_reconcileRequestedAt_idx" ON "PayrollPayment"("reconcileRequestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_businessId_id_key" ON "PayrollPayment"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_businessId_createdByUserId_requestKey_key" ON "PayrollPayment"("businessId", "createdByUserId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_provider_remitaRRR_key" ON "PayrollPayment"("provider", "remitaRRR");

-- AddForeignKey
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_businessId_batchId_fkey" FOREIGN KEY ("businessId", "batchId") REFERENCES "PayrollBatch"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollMockEvent" ADD CONSTRAINT "PayrollMockEvent_businessId_paymentId_fkey" FOREIGN KEY ("businessId", "paymentId") REFERENCES "PayrollPayment"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Safety constraints supplement application validation; approved instructions never change.
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_totals_check" CHECK (
 "totalNetSalaryKobo">0 AND "platformFeeKobo">0 AND "providerFeeKobo" IS NULL AND
 "totalInvoiceKobo"="totalNetSalaryKobo"+"platformFeeKobo" AND "totalInvoiceKobo"<=999999999999999999);
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_provider_check" CHECK ("provider" IN ('remita_mock','remita_sandbox'));
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_state_check" CHECK ("state" IN ('DRAFT','APPROVED','CREATING','INVOICE_UNKNOWN','INVOICE_READY','CANCEL_REQUESTED','CANCEL_UNKNOWN','CANCELLED'));
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_collection_check" CHECK ("providerStatus" IN ('UNKNOWN','UNPAID','PAID','FAILED','MISMATCH','REVERSED'));
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_settlement_check" CHECK ("settlementStatus" IN ('UNKNOWN','PARTIAL','SETTLED','REVERSED') AND ("provider"='remita_mock' OR ("settlementStatus"='UNKNOWN' AND "recipientEvidence"='[]'::jsonb)));
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_approval_check" CHECK (("approvedByUserId" IS NULL AND "approvedAt" IS NULL) OR ("approvedByUserId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedByUserId"<>"createdByUserId"));
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_actor_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT;
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_approver_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "PayrollPayment_one_active_instruction" ON "PayrollPayment"("businessId","batchId") WHERE "state"<>'CANCELLED';
CREATE FUNCTION protect_payroll_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b "PayrollBatch"%ROWTYPE; salary numeric; fee numeric; fee_count integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll payment records cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
   SELECT * INTO b FROM "PayrollBatch" WHERE "businessId"=NEW."businessId" AND "id"=NEW."batchId" FOR SHARE;
   IF b."id" IS NULL OR b."status"<>'approved' OR b."currency"<>'NGN' OR NEW."state"<>'DRAFT' OR NEW."approvedByUserId" IS NOT NULL OR NEW."remitaRRR" IS NOT NULL THEN RAISE EXCEPTION 'Approved payroll required'; END IF;
   IF jsonb_typeof(NEW."snapshot"->'beneficiaries') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW."snapshot"->'beneficiaries') NOT BETWEEN 2 AND 251 THEN RAISE EXCEPTION 'Invalid beneficiaries'; END IF;
   SELECT coalesce(sum((v->>'amountKobo')::numeric) FILTER (WHERE v->>'recipientType'='EMPLOYEE'),0),coalesce(sum((v->>'amountKobo')::numeric) FILTER (WHERE v->>'recipientType'='PLATFORM_FEE'),0),count(*) FILTER (WHERE v->>'recipientType'='PLATFORM_FEE') INTO salary,fee,fee_count FROM jsonb_array_elements(NEW."snapshot"->'beneficiaries') v;
   IF fee_count<>1 OR salary<>NEW."totalNetSalaryKobo" OR fee<>NEW."platformFeeKobo" OR NEW."snapshot"->>'totalInvoiceKobo' IS DISTINCT FROM NEW."totalInvoiceKobo"::text THEN RAISE EXCEPTION 'Invalid snapshot totals'; END IF;
 ELSE
   IF ROW(NEW."id",NEW."businessId",NEW."batchId",NEW."provider",NEW."merchantReference",NEW."snapshot",NEW."snapshotHash",NEW."totalNetSalaryKobo",NEW."platformFeeKobo",NEW."providerFeeKobo",NEW."totalInvoiceKobo",NEW."createdByUserId",NEW."requestKey",NEW."requestHash",NEW."createdAt") IS DISTINCT FROM ROW(OLD."id",OLD."businessId",OLD."batchId",OLD."provider",OLD."merchantReference",OLD."snapshot",OLD."snapshotHash",OLD."totalNetSalaryKobo",OLD."platformFeeKobo",OLD."providerFeeKobo",OLD."totalInvoiceKobo",OLD."createdByUserId",OLD."requestKey",OLD."requestHash",OLD."createdAt") THEN RAISE EXCEPTION 'Instruction snapshot is immutable'; END IF;
   IF OLD."state"<>'DRAFT' AND ROW(NEW."approvedByUserId",NEW."approvedAt") IS DISTINCT FROM ROW(OLD."approvedByUserId",OLD."approvedAt") THEN RAISE EXCEPTION 'Approval is immutable'; END IF;
   IF OLD."remitaRRR" IS NOT NULL AND NEW."remitaRRR" IS DISTINCT FROM OLD."remitaRRR" THEN RAISE EXCEPTION 'RRR is immutable'; END IF;
   IF OLD."state"='CANCELLED' THEN RAISE EXCEPTION 'Cancelled instruction is immutable'; END IF;
   IF NEW."state"<>OLD."state" AND NOT (
    (OLD."state"='DRAFT' AND NEW."state" IN ('APPROVED','CANCELLED')) OR
    (OLD."state"='APPROVED' AND NEW."state" IN ('CREATING','CANCELLED')) OR
    (OLD."state"='CREATING' AND NEW."state" IN ('INVOICE_UNKNOWN','INVOICE_READY')) OR
    (OLD."state"='INVOICE_UNKNOWN' AND NEW."state"='INVOICE_READY') OR
    (OLD."state"='INVOICE_READY' AND NEW."state"='CANCEL_REQUESTED') OR
    (OLD."state"='CANCEL_REQUESTED' AND NEW."state" IN ('CANCELLED','CANCEL_UNKNOWN'))
   ) THEN RAISE EXCEPTION 'Invalid payment transition'; END IF;
 END IF;
 IF NEW."state" NOT IN ('DRAFT','CANCELLED') AND NEW."approvedAt" IS NULL THEN RAISE EXCEPTION 'Payment approval required'; END IF;
 IF NEW."state"='APPROVED' AND OLD."state"='DRAFT' AND EXISTS (SELECT 1 FROM "PayrollBatch" approval_batch WHERE approval_batch."id"=NEW."batchId" AND NEW."approvedByUserId"=ANY(approval_batch."contributorUserIds")) THEN RAISE EXCEPTION 'Independent payment approval required'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PayrollPayment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollPayment" FOR EACH ROW EXECUTE FUNCTION protect_payroll_payment();
CREATE FUNCTION protect_payroll_mock_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Mock events are append only'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "PayrollPayment" WHERE "id"=NEW."paymentId" AND "businessId"=NEW."businessId" AND "provider"='remita_mock') THEN RAISE EXCEPTION 'Mock-only event'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PayrollMockEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollMockEvent" FOR EACH ROW EXECUTE FUNCTION protect_payroll_mock_event();

COMMIT;
