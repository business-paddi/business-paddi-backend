CREATE TABLE "PolicyClass" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PolicyClass_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PolicyClass_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "PolicyClass_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PolicyClass_businessId_key_key" ON "PolicyClass"("businessId", "key");
CREATE UNIQUE INDEX "PolicyClass_businessId_id_key" ON "PolicyClass"("businessId", "id");

CREATE TABLE "BusinessPolicy" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "sourceText" VARCHAR(2000),
  "durationDays" INTEGER,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BusinessPolicy_dates_check" CHECK ("endsOn" >= "startsOn"),
  CONSTRAINT "BusinessPolicy_duration_check" CHECK ("durationDays" IS NULL OR ("durationDays" BETWEEN 1 AND 3650 AND "durationDays" <= ("endsOn" - "startsOn" + 1))),
  CONSTRAINT "BusinessPolicy_name_check" CHECK (length(trim("name")) > 0),
  CONSTRAINT "BusinessPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BusinessPolicy_businessId_classId_fkey" FOREIGN KEY ("businessId", "classId") REFERENCES "PolicyClass"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "BusinessPolicy_businessId_groupId_fkey" FOREIGN KEY ("businessId", "groupId") REFERENCES "EmployeeGroup"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "BusinessPolicy_businessId_id_key" ON "BusinessPolicy"("businessId", "id");
CREATE INDEX "BusinessPolicy_businessId_createdAt_idx" ON "BusinessPolicy"("businessId", "createdAt");

CREATE TABLE "EmployeePolicyAssignment" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeePolicyAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeePolicyAssignment_businessId_policyId_fkey" FOREIGN KEY ("businessId", "policyId") REFERENCES "BusinessPolicy"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "EmployeePolicyAssignment_businessId_employeeId_fkey" FOREIGN KEY ("businessId", "employeeId") REFERENCES "BusinessEmployee"("businessId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "EmployeePolicyAssignment_businessId_policyId_employeeId_key" ON "EmployeePolicyAssignment"("businessId", "policyId", "employeeId");
CREATE INDEX "EmployeePolicyAssignment_businessId_employeeId_idx" ON "EmployeePolicyAssignment"("businessId", "employeeId");
