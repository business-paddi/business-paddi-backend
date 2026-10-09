BEGIN;
ALTER TABLE "BusinessEmployee" ADD COLUMN "email" VARCHAR(254);
ALTER TABLE "BusinessEmployee" ALTER COLUMN "amount" DROP NOT NULL;
CREATE UNIQUE INDEX "BusinessEmployee_live_email_key" ON "BusinessEmployee" ("businessId", lower("email")) WHERE "status" <> 'archived' AND "email" IS NOT NULL;
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_email_check" CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'));
-- Historical rows remain nullable; new registrations require the four essential fields.
CREATE FUNCTION require_new_employee_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."email" IS NULL OR NEW."state" IS NULL OR NEW."employeeTypeId" IS NULL THEN
    RAISE EXCEPTION 'New employees require email, state and employee type' USING ERRCODE = '23514';
  END IF;
  IF NEW."state" NOT IN ('Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara') THEN
    RAISE EXCEPTION 'Invalid Nigerian employee state' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "EmployeeType" WHERE "id" = NEW."employeeTypeId" AND "businessId" = NEW."businessId" AND "status" = 'active' FOR SHARE) THEN
    RAISE EXCEPTION 'Employee type must be active in this business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Employee_new_identity" BEFORE INSERT ON "BusinessEmployee" FOR EACH ROW EXECUTE FUNCTION require_new_employee_identity();
ALTER TABLE "BusinessEmployee" DROP CONSTRAINT "Employee_payment_check";
-- First block any historical payable rows that lack compensation (normally impossible).
UPDATE "BusinessEmployee" SET "paymentStatus" = 'blocked', "paymentBlockedReason" = 'missing_compensation' WHERE "amount" IS NULL;
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_payment_check" CHECK ("paymentStatus" <> 'payable' OR
 ("amount" IS NOT NULL AND "bankCode" IS NOT NULL AND "accountNumber" IS NOT NULL AND "accountName" IS NOT NULL
 AND "accountVerificationStatus" = 'verified' AND "verificationMode" IS NOT NULL AND "verificationMode" = 'live' AND "status" = 'active'));
CREATE FUNCTION block_ineligible_employee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount" IS NULL OR NEW."status" <> 'active' THEN
    NEW."paymentStatus" := 'blocked';
    NEW."paymentBlockedReason" := CASE WHEN NEW."amount" IS NULL THEN 'missing_compensation' ELSE 'employee_not_active' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Employee_payment_eligibility" BEFORE INSERT OR UPDATE ON "BusinessEmployee" FOR EACH ROW EXECUTE FUNCTION block_ineligible_employee();

CREATE TYPE "BusinessInviteStatus" AS ENUM ('pending','accepted','expired','revoked');
CREATE TYPE "InviteDeliveryStatus" AS ENUM ('pending','sent','failed');
CREATE TABLE "BusinessInvite" (
 "id" TEXT PRIMARY KEY, "businessId" TEXT NOT NULL, "email" VARCHAR(254) NOT NULL,
 "employeeId" TEXT, "roleId" TEXT NOT NULL, "invitedByUserId" TEXT NOT NULL,
 "status" "BusinessInviteStatus" NOT NULL DEFAULT 'pending', "tokenHash" CHAR(64) NOT NULL,
 "deliveryStatus" "InviteDeliveryStatus" NOT NULL DEFAULT 'pending', "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "acceptedAt" TIMESTAMPTZ(3), "revokedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
 CONSTRAINT "BusinessInvite_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BusinessInvite_businessId_employeeId_fkey" FOREIGN KEY ("businessId","employeeId") REFERENCES "BusinessEmployee"("businessId","id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BusinessInvite_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "BusinessInvite_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "Invite_email_check" CHECK ("email" = lower(btrim("email")) AND "email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 CONSTRAINT "Invite_hash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
 CONSTRAINT "Invite_lifecycle_check" CHECK (("status" = 'accepted') = ("acceptedAt" IS NOT NULL) AND ("status" = 'revoked') = ("revokedAt" IS NOT NULL)),
 CONSTRAINT "Invite_attempts_check" CHECK ("deliveryAttempts" >= 0)
);
CREATE UNIQUE INDEX "BusinessInvite_tokenHash_key" ON "BusinessInvite"("tokenHash");
CREATE INDEX "BusinessInvite_businessId_status_idx" ON "BusinessInvite"("businessId","status");
CREATE UNIQUE INDEX "BusinessInvite_pending_email_key" ON "BusinessInvite"("businessId",lower("email")) WHERE "status" = 'pending';
CREATE FUNCTION check_invite_role_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r "Role";
BEGIN
 SELECT * INTO r FROM "Role" WHERE "id" = NEW."roleId" FOR SHARE;
 IF r."id" IS NULL OR r."status" <> 'active' OR (r."type" = 'system' AND r."key" = 'owner') OR (r."type" = 'custom' AND r."businessId" IS DISTINCT FROM NEW."businessId") THEN
  RAISE EXCEPTION 'Invalid invitation role' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BusinessInvite_role_guard" BEFORE INSERT OR UPDATE OF "roleId","businessId" ON "BusinessInvite" FOR EACH ROW EXECUTE FUNCTION check_invite_role_scope();
CREATE TRIGGER "BusinessInvite_updatedAt" BEFORE UPDATE ON "BusinessInvite" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TABLE "BusinessCreationRequest" (
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "key" VARCHAR(80) NOT NULL, "requestHash" CHAR(64) NOT NULL,
 "businessId" TEXT NOT NULL REFERENCES "Business"("id") ON DELETE RESTRICT,
 "result" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("userId", "key")
);
COMMIT;
