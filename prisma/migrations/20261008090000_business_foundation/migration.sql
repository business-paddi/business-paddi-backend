BEGIN;

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('active', 'suspended', 'archived');

-- CreateEnum
CREATE TYPE "BusinessMemberStatus" AS ENUM ('active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "RoleType" AS ENUM ('system', 'custom');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('active', 'suspended', 'on_leave', 'archived');

-- CreateEnum
CREATE TYPE "AccountVerificationStatus" AS ENUM ('unverified', 'verified', 'failed', 'stale');

-- CreateEnum
CREATE TYPE "VerificationJobStatus" AS ENUM ('pending', 'processing', 'retrying', 'completed', 'exhausted');

-- CreateEnum
CREATE TYPE "VerificationMode" AS ENUM ('demo', 'live');

-- CreateEnum
CREATE TYPE "PayFrequency" AS ENUM ('weekly', 'bi-weekly', 'monthly', 'one_time');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('payable', 'blocked');


-- DropForeignKey
ALTER TABLE "StaffInvite" DROP CONSTRAINT "StaffInvite_businessId_fkey";


-- AlterTable
ALTER TABLE "Business"
ADD COLUMN     "country" CHAR(2) NOT NULL DEFAULT 'NG',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "profileImage" TEXT,
ADD COLUMN     "status" "BusinessStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "updatedAt" TIMESTAMPTZ(3);
UPDATE "Business" SET "updatedAt" = "createdAt";
ALTER TABLE "Business" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "name" VARCHAR(100) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "type" "RoleType" NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permission" VARCHAR(100) NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "RoleDeniedPermission" (
    "roleId" TEXT NOT NULL,
    "permission" VARCHAR(100) NOT NULL,

    CONSTRAINT "RoleDeniedPermission_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "Permission" (
    "key" VARCHAR(100) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BusinessMember" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "status" "BusinessMemberStatus" NOT NULL DEFAULT 'active',
    "invitedByUserId" TEXT,
    "roleUpdatedByUserId" TEXT,
    "roleUpdatedAt" TIMESTAMPTZ(3),
    "statusUpdatedByUserId" TEXT,
    "statusUpdatedAt" TIMESTAMPTZ(3),
    "removedByUserId" TEXT,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeType" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeGroup" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessEmployee" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "businessMemberId" TEXT,
    "employeeTypeId" TEXT,
    "managerEmployeeId" TEXT,
    "state" VARCHAR(100),
    "fullName" VARCHAR(200) NOT NULL,
    "jobTitle" VARCHAR(100),
    "bankCode" VARCHAR(30),
    "bankName" VARCHAR(100),
    "accountNumber" TEXT,
    "accountName" TEXT,
    "accountVerificationStatus" "AccountVerificationStatus" NOT NULL DEFAULT 'unverified',
    "verificationJobStatus" "VerificationJobStatus" NOT NULL DEFAULT 'pending',
    "verificationMode" "VerificationMode",
    "verificationAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "accountVerifiedAt" TIMESTAMPTZ(3),
    "accountVerificationFailureReason" TEXT,
    "lastAccountValidationAt" TIMESTAMPTZ(3),
    "nextVerificationAttemptAt" TIMESTAMPTZ(3),
    "amount" DECIMAL(18,2) NOT NULL,
    "payFrequency" "PayFrequency" NOT NULL DEFAULT 'monthly',
    "totalAmountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "lastPaidAt" TIMESTAMPTZ(3),
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'blocked',
    "paymentBlockedReason" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessEmployeeGroup" (
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessEmployeeGroup_pkey" PRIMARY KEY ("businessId","employeeId","groupId")
);

-- CreateTable
CREATE TABLE "EmployeeTaxProfile" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "taxIdentificationNumber" TEXT,
    "taxResidenceState" VARCHAR(100),
    "taxResidenceCountry" CHAR(2) NOT NULL DEFAULT 'NG',
    "employmentStartDate" DATE,
    "employmentEndDate" DATE,
    "taxResidencyStatus" VARCHAR(50),
    "pensionFundAdministrator" VARCHAR(200),
    "pensionAccountNumber" TEXT,
    "pensionContributionRate" DECIMAL(7,4),
    "employerPensionContributionRate" DECIMAL(7,4),
    "nhfApplicable" BOOLEAN,
    "nhisApplicable" BOOLEAN,
    "taxExemptionStatus" VARCHAR(50),
    "taxExemptionReason" TEXT,
    "additionalTaxInformation" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeTaxProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_businessId_key_key" ON "Role"("businessId", "key");

-- CreateIndex
CREATE INDEX "BusinessMember_userId_status_idx" ON "BusinessMember"("userId", "status");

-- CreateIndex
CREATE INDEX "BusinessMember_businessId_status_idx" ON "BusinessMember"("businessId", "status");

-- CreateIndex
CREATE INDEX "BusinessMember_roleId_idx" ON "BusinessMember"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMember_businessId_userId_key" ON "BusinessMember"("businessId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMember_businessId_id_key" ON "BusinessMember"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeType_businessId_key_key" ON "EmployeeType"("businessId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeType_businessId_id_key" ON "EmployeeType"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeGroup_businessId_name_key" ON "EmployeeGroup"("businessId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeGroup_businessId_id_key" ON "EmployeeGroup"("businessId", "id");

-- CreateIndex
CREATE INDEX "BusinessEmployee_businessId_status_idx" ON "BusinessEmployee"("businessId", "status");

-- CreateIndex
CREATE INDEX "BusinessEmployee_businessId_managerEmployeeId_idx" ON "BusinessEmployee"("businessId", "managerEmployeeId");

-- CreateIndex
CREATE INDEX "BusinessEmployee_businessId_employeeTypeId_idx" ON "BusinessEmployee"("businessId", "employeeTypeId");

-- CreateIndex
CREATE INDEX "BusinessEmployee_verificationJobStatus_nextVerificationAtte_idx" ON "BusinessEmployee"("verificationJobStatus", "nextVerificationAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEmployee_businessId_id_key" ON "BusinessEmployee"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEmployee_businessId_businessMemberId_key" ON "BusinessEmployee"("businessId", "businessMemberId");

-- CreateIndex
CREATE INDEX "BusinessEmployeeGroup_businessId_groupId_idx" ON "BusinessEmployeeGroup"("businessId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTaxProfile_employeeId_key" ON "EmployeeTaxProfile"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeTaxProfile_businessId_idx" ON "EmployeeTaxProfile"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeTaxProfile_businessId_employeeId_key" ON "EmployeeTaxProfile"("businessId", "employeeId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permission_fkey" FOREIGN KEY ("permission") REFERENCES "Permission"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleDeniedPermission" ADD CONSTRAINT "RoleDeniedPermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleDeniedPermission" ADD CONSTRAINT "RoleDeniedPermission_permission_fkey" FOREIGN KEY ("permission") REFERENCES "Permission"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_roleUpdatedByUserId_fkey" FOREIGN KEY ("roleUpdatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_statusUpdatedByUserId_fkey" FOREIGN KEY ("statusUpdatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeType" ADD CONSTRAINT "EmployeeType_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeGroup" ADD CONSTRAINT "EmployeeGroup_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_businessId_businessMemberId_fkey" FOREIGN KEY ("businessId", "businessMemberId") REFERENCES "BusinessMember"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_businessId_employeeTypeId_fkey" FOREIGN KEY ("businessId", "employeeTypeId") REFERENCES "EmployeeType"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_businessId_managerEmployeeId_fkey" FOREIGN KEY ("businessId", "managerEmployeeId") REFERENCES "BusinessEmployee"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployeeGroup" ADD CONSTRAINT "BusinessEmployeeGroup_businessId_employeeId_fkey" FOREIGN KEY ("businessId", "employeeId") REFERENCES "BusinessEmployee"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEmployeeGroup" ADD CONSTRAINT "BusinessEmployeeGroup_businessId_groupId_fkey" FOREIGN KEY ("businessId", "groupId") REFERENCES "EmployeeGroup"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "EmployeeTaxProfile_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "EmployeeTaxProfile_businessId_employeeId_fkey" FOREIGN KEY ("businessId", "employeeId") REFERENCES "BusinessEmployee"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StaffInvite" ADD CONSTRAINT "StaffInvite_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- System role uniqueness must account for PostgreSQL NULL semantics.
CREATE UNIQUE INDEX "Role_system_key_key" ON "Role" ("key") WHERE "businessId" IS NULL;
ALTER TABLE "Role" ADD CONSTRAINT "Role_system_catalog_check" CHECK ("type" <> 'system' OR "key" IN ('owner','admin','finance_manager','accountant','employee','contributor','viewer'));
ALTER TABLE "Role" ADD CONSTRAINT "Role_scope_check" CHECK
  (("type" = 'system' AND "businessId" IS NULL) OR ("type" = 'custom' AND "businessId" IS NOT NULL));
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_catalog_check" CHECK ("key" IN ('business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage'));
INSERT INTO "Permission" ("key") VALUES ('business:update'),('members:invite'),('members:remove'),('members:update_role'),('members:update_status'),('members:view'),('roles:view'),('roles:create'),('roles:update'),('roles:delete'),('roles:assign'),('payments:create'),('payments:view'),('payments:view_own'),('payments:approve'),('payments:cancel'),('providers:create'),('providers:update'),('providers:view'),('invoices:create'),('employee_lists:create'),('employee_lists:view'),('employee_lists:update'),('employee_lists:archive'),('employees:create'),('employees:view'),('employees:update'),('employees:archive'),('employees:verify'),('invoices:view'),('reports:view'),('audit_logs:view'),('employees:view_own'),('policies:view'),('policies:create'),('policies:update'),('policies:archive'),('policies:assign'),('policies:view_audit'),('policies:reconcile'),('integrations:view'),('integrations:manage') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-owner','owner','owner','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-owner','business:update'),('system-role-owner','members:invite'),('system-role-owner','members:remove'),('system-role-owner','members:update_role'),('system-role-owner','members:update_status'),('system-role-owner','members:view'),('system-role-owner','roles:view'),('system-role-owner','roles:create'),('system-role-owner','roles:update'),('system-role-owner','roles:delete'),('system-role-owner','roles:assign'),('system-role-owner','payments:create'),('system-role-owner','payments:view'),('system-role-owner','payments:view_own'),('system-role-owner','payments:approve'),('system-role-owner','payments:cancel'),('system-role-owner','providers:create'),('system-role-owner','providers:update'),('system-role-owner','providers:view'),('system-role-owner','invoices:create'),('system-role-owner','employee_lists:create'),('system-role-owner','employee_lists:view'),('system-role-owner','employee_lists:update'),('system-role-owner','employee_lists:archive'),('system-role-owner','employees:create'),('system-role-owner','employees:view'),('system-role-owner','employees:update'),('system-role-owner','employees:archive'),('system-role-owner','employees:verify'),('system-role-owner','invoices:view'),('system-role-owner','reports:view'),('system-role-owner','audit_logs:view'),('system-role-owner','employees:view_own'),('system-role-owner','policies:view'),('system-role-owner','policies:create'),('system-role-owner','policies:update'),('system-role-owner','policies:archive'),('system-role-owner','policies:assign'),('system-role-owner','policies:view_audit'),('system-role-owner','policies:reconcile'),('system-role-owner','integrations:view'),('system-role-owner','integrations:manage') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-admin','admin','admin','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-admin','members:invite'),('system-role-admin','members:view'),('system-role-admin','members:update_status'),('system-role-admin','payments:create'),('system-role-admin','payments:approve'),('system-role-admin','payments:view'),('system-role-admin','providers:create'),('system-role-admin','providers:update'),('system-role-admin','invoices:create'),('system-role-admin','invoices:view'),('system-role-admin','reports:view'),('system-role-admin','audit_logs:view'),('system-role-admin','employee_lists:create'),('system-role-admin','employee_lists:view'),('system-role-admin','employee_lists:update'),('system-role-admin','employee_lists:archive'),('system-role-admin','employees:create'),('system-role-admin','employees:view'),('system-role-admin','employees:update'),('system-role-admin','employees:archive'),('system-role-admin','employees:verify'),('system-role-admin','integrations:view'),('system-role-admin','integrations:manage') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-finance_manager','finance_manager','finance manager','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-finance_manager','payments:create'),('system-role-finance_manager','payments:approve'),('system-role-finance_manager','payments:view'),('system-role-finance_manager','providers:create'),('system-role-finance_manager','invoices:create'),('system-role-finance_manager','invoices:view'),('system-role-finance_manager','reports:view'),('system-role-finance_manager','employee_lists:create'),('system-role-finance_manager','employee_lists:view'),('system-role-finance_manager','employee_lists:update'),('system-role-finance_manager','employees:create'),('system-role-finance_manager','employees:view'),('system-role-finance_manager','employees:update'),('system-role-finance_manager','employees:verify'),('system-role-finance_manager','members:view') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-accountant','accountant','accountant','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-accountant','payments:view'),('system-role-accountant','invoices:view'),('system-role-accountant','reports:view'),('system-role-accountant','members:view'),('system-role-accountant','employee_lists:view'),('system-role-accountant','employees:view') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-employee','employee','employee','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-employee','employees:view_own'),('system-role-employee','members:view'),('system-role-employee','employee_lists:view'),('system-role-employee','reports:view') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-contributor','contributor','contributor','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-contributor','payments:create'),('system-role-contributor','members:view'),('system-role-contributor','payments:view_own') ON CONFLICT DO NOTHING;
INSERT INTO "Role" ("id","key","name","type","status","updatedAt") VALUES ('system-role-viewer','viewer','viewer','system','active',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") VALUES ('system-role-viewer','payments:view'),('system-role-viewer','invoices:view'),('system-role-viewer','members:view'),('system-role-viewer','reports:view') ON CONFLICT DO NOTHING;

-- Preserve existing ownership as active memberships BEFORE dropping the legacy column.
INSERT INTO "BusinessMember" ("id","businessId","userId","roleId","status","createdAt","updatedAt")
SELECT 'legacy-owner-' || "id", "id", "ownerId", 'system-role-owner', 'active', "createdAt", CURRENT_TIMESTAMP
FROM "Business";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "Business" b WHERE NOT EXISTS (
    SELECT 1 FROM "BusinessMember" m WHERE m."businessId"=b."id" AND m."userId"=b."ownerId" AND m."roleId"='system-role-owner'
  )) THEN RAISE EXCEPTION 'Owner membership backfill was incomplete'; END IF;
END $$;
ALTER TABLE "Business" DROP CONSTRAINT "Business_ownerId_fkey";
DROP INDEX "Business_ownerId_idx";
ALTER TABLE "Business" DROP COLUMN "ownerId";

ALTER TABLE "Business" ADD CONSTRAINT "Business_country_check" CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "Business" ADD CONSTRAINT "Business_name_check" CHECK (length(btrim("name")) > 0);
ALTER TABLE "Role" ADD CONSTRAINT "Role_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "Role" ADD CONSTRAINT "Role_name_check" CHECK (length(btrim("name")) > 0);
ALTER TABLE "EmployeeType" ADD CONSTRAINT "EmployeeType_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE "EmployeeType" ADD CONSTRAINT "EmployeeType_name_check" CHECK (length(btrim("name")) > 0);
ALTER TABLE "EmployeeGroup" ADD CONSTRAINT "EmployeeGroup_name_check" CHECK (length(btrim("name")) > 0);
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_name_check" CHECK ("fullName" = btrim("fullName") AND length("fullName") > 0);
ALTER TABLE "BusinessMember" ADD CONSTRAINT "Member_change_metadata_check" CHECK
 (("roleUpdatedByUserId" IS NULL) = ("roleUpdatedAt" IS NULL) AND
  ("statusUpdatedByUserId" IS NULL) = ("statusUpdatedAt" IS NULL) AND
  ("removedByUserId" IS NULL) = ("removedAt" IS NULL) AND
  ("status" <> 'removed' OR ("removedByUserId" IS NOT NULL AND "removedAt" IS NOT NULL)));
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_amount_check" CHECK ("amount" >= 0 AND "totalAmountPaid" >= 0);
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_attempts_check" CHECK ("verificationAttemptCount" >= 0);
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_manager_check" CHECK ("managerEmployeeId" IS NULL OR "managerEmployeeId" <> "id");
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_bank_check" CHECK
 (("bankCode" IS NULL OR length(btrim("bankCode")) > 0) AND ("bankName" IS NULL OR length(btrim("bankName")) > 0));
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_verified_check" CHECK
 ("accountVerificationStatus" <> 'verified' OR ("bankCode" IS NOT NULL AND "bankName" IS NOT NULL AND "accountNumber" IS NOT NULL AND "accountVerifiedAt" IS NOT NULL AND "verificationMode" IS NOT NULL AND "verificationJobStatus" = 'completed'));
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_payment_check" CHECK
 ("paymentStatus" <> 'payable' OR ("bankCode" IS NOT NULL AND "bankName" IS NOT NULL AND "accountNumber" IS NOT NULL AND "accountVerificationStatus" = 'verified' AND "verificationMode" IS NOT NULL AND "verificationMode" = 'live' AND "status" = 'active'));
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "Employee_job_check" CHECK
 (("verificationJobStatus" NOT IN ('processing','retrying','completed','exhausted') AND "nextVerificationAttemptAt" IS NULL) OR
  ("bankCode" IS NOT NULL AND "bankName" IS NOT NULL AND "accountNumber" IS NOT NULL AND "verificationMode" IS NOT NULL));
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "Tax_dates_check" CHECK ("employmentEndDate" IS NULL OR "employmentStartDate" IS NULL OR "employmentEndDate" >= "employmentStartDate");
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "Tax_rates_check" CHECK
 (("pensionContributionRate" IS NULL OR "pensionContributionRate" BETWEEN 0 AND 100) AND ("employerPensionContributionRate" IS NULL OR "employerPensionContributionRate" BETWEEN 0 AND 100));
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "Tax_country_check" CHECK ("taxResidenceCountry" ~ '^[A-Z]{2}$');
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_accountNumber_encrypted" CHECK ("accountNumber" IS NULL OR "accountNumber" ~ '^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:([a-f0-9]{2})+$');
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_accountName_encrypted" CHECK ("accountName" IS NULL OR "accountName" ~ '^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:([a-f0-9]{2})+$');
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "EmployeeTaxProfile_taxIdentificationNumber_encrypted" CHECK ("taxIdentificationNumber" IS NULL OR "taxIdentificationNumber" ~ '^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:([a-f0-9]{2})+$');
ALTER TABLE "EmployeeTaxProfile" ADD CONSTRAINT "EmployeeTaxProfile_pensionAccountNumber_encrypted" CHECK ("pensionAccountNumber" IS NULL OR "pensionAccountNumber" ~ '^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:([a-f0-9]{2})+$');

-- Roles cannot be moved between scopes; system role definitions are immutable.
CREATE FUNCTION protect_role_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'system' THEN RAISE EXCEPTION 'System roles cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."businessId" IS DISTINCT FROM OLD."businessId" OR NEW."type" IS DISTINCT FROM OLD."type" THEN
    RAISE EXCEPTION 'Role scope cannot be changed';
  END IF;
  IF OLD."type"='system' AND (NEW."id" IS DISTINCT FROM OLD."id" OR NEW."key" IS DISTINCT FROM OLD."key" OR NEW."name" IS DISTINCT FROM OLD."name" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'System roles cannot be edited or archived';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Role_scope_guard" BEFORE UPDATE OR DELETE ON "Role" FOR EACH ROW EXECUTE FUNCTION protect_role_scope();

CREATE FUNCTION check_member_role_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned "Role"%ROWTYPE; old_role "Role"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Membership history must be retained; mark removed instead'; END IF;
  SELECT * INTO assigned FROM "Role" WHERE "id"=NEW."roleId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assigned role does not exist'; END IF;
  IF assigned."type"='custom' AND assigned."businessId" IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION 'Custom role must belong to the same business';
  END IF;
  IF TG_OP='INSERT' AND assigned."type"='system' AND assigned."key"='owner' AND NEW."status" <> 'active' THEN RAISE EXCEPTION 'New owner memberships must be active'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW."businessId" IS DISTINCT FROM OLD."businessId" OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN RAISE EXCEPTION 'Membership identity cannot be changed'; END IF;
    SELECT * INTO old_role FROM "Role" WHERE "id"=OLD."roleId";
    IF (old_role."type"='system' AND old_role."key"='owner') AND (NEW."roleId" IS DISTINCT FROM OLD."roleId" OR NEW."status" IS DISTINCT FROM OLD."status") THEN RAISE EXCEPTION 'Owner updates and transfers are out of scope'; END IF;
    IF NEW."roleId" IS DISTINCT FROM OLD."roleId" AND assigned."type"='system' AND assigned."key"='owner' THEN RAISE EXCEPTION 'Owner reassignment is out of scope'; END IF;
    IF NEW."roleId" IS DISTINCT FROM OLD."roleId" AND (NEW."roleUpdatedByUserId" IS NULL OR NEW."roleUpdatedAt" IS NULL) THEN RAISE EXCEPTION 'Role changes require actor and timestamp'; END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND (NEW."statusUpdatedByUserId" IS NULL OR NEW."statusUpdatedAt" IS NULL) THEN RAISE EXCEPTION 'Status changes require actor and timestamp'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BusinessMember_role_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BusinessMember" FOR EACH ROW EXECUTE FUNCTION check_member_role_scope();

-- Bank changes invalidate verification even when writes bypass the ORM.
CREATE FUNCTION invalidate_bank_verification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."bankCode" IS DISTINCT FROM OLD."bankCode" OR NEW."accountNumber" IS DISTINCT FROM OLD."accountNumber" THEN
    NEW."accountName" := NULL;
    NEW."accountVerificationStatus" := 'unverified';
    NEW."verificationJobStatus" := 'pending';
    NEW."verificationMode" := NULL;
    NEW."verificationAttemptCount" := 0;
    NEW."accountVerifiedAt" := NULL;
    NEW."accountVerificationFailureReason" := NULL;
    NEW."lastAccountValidationAt" := NULL;
    NEW."nextVerificationAttemptAt" := NULL;
    NEW."paymentStatus" := 'blocked';
    NEW."paymentBlockedReason" := 'bank_details_changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BusinessEmployee_bank_guard" BEFORE UPDATE ON "BusinessEmployee" FOR EACH ROW EXECUTE FUNCTION invalidate_bank_verification();

CREATE FUNCTION touch_business_foundation_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."updatedAt" := statement_timestamp(); RETURN NEW; END $$;
CREATE TRIGGER "Business_updatedAt" BEFORE UPDATE ON "Business" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "BusinessMember_updatedAt" BEFORE UPDATE ON "BusinessMember" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "BusinessEmployee_updatedAt" BEFORE UPDATE ON "BusinessEmployee" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "EmployeeType_updatedAt" BEFORE UPDATE ON "EmployeeType" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "EmployeeGroup_updatedAt" BEFORE UPDATE ON "EmployeeGroup" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "EmployeeTaxProfile_updatedAt" BEFORE UPDATE ON "EmployeeTaxProfile" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();
CREATE TRIGGER "Role_updatedAt" BEFORE UPDATE ON "Role" FOR EACH ROW EXECUTE FUNCTION touch_business_foundation_timestamp();

CREATE FUNCTION protect_system_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assigned "Role"%ROWTYPE; previous "Role"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    SELECT * INTO previous FROM "Role" WHERE "id"=OLD."roleId";
    IF previous."type"='system' THEN RAISE EXCEPTION 'System permission assignments cannot be edited or removed'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO assigned FROM "Role" WHERE "id"=NEW."roleId";
  IF assigned."type"='system' THEN
    IF TG_TABLE_NAME='RoleDeniedPermission' THEN RAISE EXCEPTION 'System roles have no explicit denials'; END IF;
    IF NOT ((assigned."key"='owner' AND NEW."permission" IN ('business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage')) OR (assigned."key"='admin' AND NEW."permission" IN ('members:invite','members:view','members:update_status','payments:create','payments:approve','payments:view','providers:create','providers:update','invoices:create','invoices:view','reports:view','audit_logs:view','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','integrations:view','integrations:manage')) OR (assigned."key"='finance_manager' AND NEW."permission" IN ('payments:create','payments:approve','payments:view','providers:create','invoices:create','invoices:view','reports:view','employee_lists:create','employee_lists:view','employee_lists:update','employees:create','employees:view','employees:update','employees:verify','members:view')) OR (assigned."key"='accountant' AND NEW."permission" IN ('payments:view','invoices:view','reports:view','members:view','employee_lists:view','employees:view')) OR (assigned."key"='employee' AND NEW."permission" IN ('employees:view_own','members:view','employee_lists:view','reports:view')) OR (assigned."key"='contributor' AND NEW."permission" IN ('payments:create','members:view','payments:view_own')) OR (assigned."key"='viewer' AND NEW."permission" IN ('payments:view','invoices:view','members:view','reports:view'))) THEN RAISE EXCEPTION 'Permission is not granted to this system role'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RolePermission_system_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RolePermission" FOR EACH ROW EXECUTE FUNCTION protect_system_permissions();
CREATE TRIGGER "RoleDeniedPermission_system_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RoleDeniedPermission" FOR EACH ROW EXECUTE FUNCTION protect_system_permissions();
COMMIT;
