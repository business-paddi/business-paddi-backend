BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "EmployeeTaxProfile" ADD COLUMN "payrollInputs" JSONB;
CREATE TABLE "PayrollBatch" (
 "id" TEXT PRIMARY KEY,"businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
 "name" VARCHAR(200) NOT NULL,"status" VARCHAR(30) NOT NULL DEFAULT 'draft',
 "periodStart" CHAR(10) NOT NULL,"periodEnd" CHAR(10) NOT NULL,"payDate" CHAR(10) NOT NULL,
 "payFrequency" VARCHAR(20) NOT NULL,"currency" CHAR(3) NOT NULL DEFAULT 'NGN',"notes" VARCHAR(2000),
 "revision" INTEGER NOT NULL DEFAULT 1,"createdBy" JSONB NOT NULL,"submittedBy" JSONB,"reviewedBy" JSONB,
 "contributorUserIds" TEXT[] NOT NULL,"submittedAt" TIMESTAMPTZ(3),"approvedAt" TIMESTAMPTZ(3),"cancelledAt" TIMESTAMPTZ(3),
 "reviewNote" VARCHAR(2000),"cancellationReason" VARCHAR(2000),"calculationVersion" TEXT,"calculation" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("businessId","id"),CHECK("status" IN ('draft','submitted','changes_requested','approved','cancelled')),
 CHECK("payFrequency" IN ('weekly','bi-weekly','monthly','one_time') AND "currency"='NGN' AND "revision">0 AND length(btrim("name"))>0),
 CHECK("periodStart"::date <= "periodEnd"::date AND "payDate"::date >= "periodEnd"::date),
 CHECK(jsonb_typeof("calculation")='object' AND jsonb_typeof("createdBy")='object' AND cardinality("contributorUserIds")>0)
);
CREATE INDEX "PayrollBatch_businessId_createdAt_id_idx" ON "PayrollBatch"("businessId","createdAt","id");
CREATE TABLE "PayrollRecipient" (
 "id" TEXT PRIMARY KEY,"businessId" TEXT NOT NULL,"batchId" TEXT NOT NULL,"employeeId" TEXT NOT NULL,
 "source" JSONB NOT NULL,"sourceVersion" CHAR(64) NOT NULL,"snapshottedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "baseAmount" VARCHAR(19),"baseOverrideReason" VARCHAR(1000),"adjustments" JSONB NOT NULL DEFAULT '[]',"calculation" JSONB NOT NULL,
 "notes" VARCHAR(2000),"removed" BOOLEAN NOT NULL DEFAULT false,
 FOREIGN KEY("businessId","batchId") REFERENCES "PayrollBatch"("businessId","id") ON DELETE RESTRICT,
 FOREIGN KEY("businessId","employeeId") REFERENCES "BusinessEmployee"("businessId","id") ON DELETE RESTRICT,
 UNIQUE("batchId","employeeId"),CHECK(jsonb_typeof("source")='object' AND jsonb_typeof("adjustments")='array' AND jsonb_typeof("calculation")='object'),
 CHECK("baseAmount" IS NULL OR ("baseAmount" ~ '^(0|[1-9][0-9]{0,15})\.[0-9]{2}$' AND coalesce(length(btrim("baseOverrideReason")),0)>0)),
 CHECK(("source"#>>'{bank,accountNumber}' IS NULL OR "source"#>>'{bank,accountNumber}' LIKE 'enc:v1:%') AND ("source"#>>'{bank,accountName}' IS NULL OR "source"#>>'{bank,accountName}' LIKE 'enc:v1:%'))
);
CREATE INDEX "PayrollRecipient_businessId_batchId_id_idx" ON "PayrollRecipient"("businessId","batchId","id");
CREATE TABLE "PayrollHistory" (
 "id" TEXT PRIMARY KEY,"batchId" TEXT NOT NULL REFERENCES "PayrollBatch"("id") ON DELETE RESTRICT,"revision" INTEGER NOT NULL,
 "event" VARCHAR(40) NOT NULL,"actor" JSONB NOT NULL,"snapshot" JSONB NOT NULL,"note" VARCHAR(2000),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("batchId","revision")
);
CREATE TABLE "PayrollOperation" (
 "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,"userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "key" VARCHAR(100) NOT NULL,"hash" CHAR(64) NOT NULL,"result" JSONB NOT NULL,"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("businessId","userId","key")
);
CREATE TABLE "PayrollObligation" (
 "id" TEXT PRIMARY KEY,"businessId" TEXT NOT NULL,"batchId" TEXT NOT NULL,"employeeId" TEXT NOT NULL,
 "periodStart" DATE NOT NULL,"periodEnd" DATE NOT NULL,
 FOREIGN KEY("businessId","batchId") REFERENCES "PayrollBatch"("businessId","id") ON DELETE RESTRICT,
 FOREIGN KEY("businessId","employeeId") REFERENCES "BusinessEmployee"("businessId","id") ON DELETE RESTRICT,
 UNIQUE("batchId","employeeId"),CHECK("periodStart"<="periodEnd"),
 EXCLUDE USING gist ("businessId" WITH =,"employeeId" WITH =,daterange("periodStart","periodEnd",'[]') WITH &&)
);
CREATE INDEX "PayrollObligation_businessId_employeeId_periodStart_periodEnd_idx" ON "PayrollObligation"("businessId","employeeId","periodStart","periodEnd");
CREATE FUNCTION protect_payroll_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Payroll history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER "PayrollHistory_immutable" BEFORE UPDATE OR DELETE ON "PayrollHistory" FOR EACH ROW EXECUTE FUNCTION protect_payroll_history();
CREATE TRIGGER "PayrollOperation_immutable" BEFORE UPDATE OR DELETE ON "PayrollOperation" FOR EACH ROW EXECUTE FUNCTION protect_payroll_history();
CREATE FUNCTION protect_payroll_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll batches cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."status"<>'draft' OR NEW."revision"<>1 OR coalesce(NEW."createdBy"->>'userId','')='' OR coalesce(NEW."createdBy"->>'userId','')<>ALL(NEW."contributorUserIds") THEN RAISE EXCEPTION 'Payroll starts as an attributed draft'; END IF;
  RETURN NEW;
 END IF;
 IF OLD."status" IN ('approved','cancelled') THEN RAISE EXCEPTION 'Final payroll snapshot is immutable'; END IF;
 IF NEW."revision"<>OLD."revision"+1 OR ROW(NEW."id",NEW."businessId",NEW."createdBy",NEW."createdAt",NEW."periodStart",NEW."periodEnd",NEW."payFrequency",NEW."currency") IS DISTINCT FROM ROW(OLD."id",OLD."businessId",OLD."createdBy",OLD."createdAt",OLD."periodStart",OLD."periodEnd",OLD."payFrequency",OLD."currency") OR NOT OLD."contributorUserIds"<@NEW."contributorUserIds" THEN RAISE EXCEPTION 'Invalid payroll revision or identity'; END IF;
 IF OLD."status"='submitted' THEN
  IF NEW."status" NOT IN ('approved','changes_requested','cancelled') OR ROW(NEW."name",NEW."payDate",NEW."notes",NEW."calculation",NEW."calculationVersion",NEW."contributorUserIds",NEW."submittedBy",NEW."submittedAt") IS DISTINCT FROM ROW(OLD."name",OLD."payDate",OLD."notes",OLD."calculation",OLD."calculationVersion",OLD."contributorUserIds",OLD."submittedBy",OLD."submittedAt") THEN RAISE EXCEPTION 'Submitted payroll cannot be edited'; END IF;
  IF NEW."status" IN ('approved','changes_requested') AND (coalesce(NEW."reviewedBy"->>'userId','')='' OR NEW."reviewedBy"->>'userId'=ANY(OLD."contributorUserIds")) THEN RAISE EXCEPTION 'Independent reviewer required'; END IF;
  IF NEW."status"='changes_requested' AND coalesce(length(btrim(NEW."reviewNote")),0)=0 THEN RAISE EXCEPTION 'Correction reason required'; END IF;
 ELSE
  IF NEW."status" NOT IN (OLD."status",'submitted','cancelled') THEN RAISE EXCEPTION 'Invalid payroll transition'; END IF;
 END IF;
 IF NEW."status"='submitted' AND (NEW."calculation"->>'calculationStatus' IS DISTINCT FROM 'ready' OR NEW."calculationVersion" IS NULL OR NEW."submittedBy" IS NULL OR coalesce(NEW."submittedBy"->>'userId','')<>ALL(NEW."contributorUserIds") OR NOT EXISTS(SELECT 1 FROM "PayrollRecipient" WHERE "batchId"=NEW."id" AND NOT "removed")) THEN RAISE EXCEPTION 'Payroll not ready'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PayrollBatch_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollBatch" FOR EACH ROW EXECUTE FUNCTION protect_payroll_batch();
CREATE FUNCTION protect_payroll_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll recipients cannot be deleted'; END IF;
 SELECT "status" INTO parent_status FROM "PayrollBatch" WHERE "id"=NEW."batchId" FOR UPDATE;
 IF parent_status NOT IN ('draft','changes_requested') THEN RAISE EXCEPTION 'Payroll recipients are locked'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW."id",NEW."businessId",NEW."batchId",NEW."employeeId") IS DISTINCT FROM ROW(OLD."id",OLD."businessId",OLD."batchId",OLD."employeeId") THEN RAISE EXCEPTION 'Recipient identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PayrollRecipient_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayrollRecipient" FOR EACH ROW EXECUTE FUNCTION protect_payroll_recipient();
CREATE FUNCTION sync_payroll_obligations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status"='submitted' AND OLD."status"<>'submitted' THEN
  INSERT INTO "PayrollObligation" ("id","businessId","batchId","employeeId","periodStart","periodEnd") SELECT gen_random_uuid()::text,NEW."businessId",NEW."id",r."employeeId",NEW."periodStart"::date,NEW."periodEnd"::date FROM "PayrollRecipient" r WHERE r."batchId"=NEW."id" AND NOT r."removed";
 ELSIF NEW."status" IN ('changes_requested','cancelled') THEN
  DELETE FROM "PayrollObligation" WHERE "batchId"=NEW."id";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "PayrollBatch_obligations" AFTER UPDATE ON "PayrollBatch" FOR EACH ROW EXECUTE FUNCTION sync_payroll_obligations();
COMMIT;
