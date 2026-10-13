BEGIN;
-- CreateTable
CREATE TABLE "BusinessTask" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(30) NOT NULL DEFAULT 'unassigned',
    "priority" VARCHAR(10) NOT NULL DEFAULT 'normal',
    "dueAt" TIMESTAMPTZ(3),
    "createdByMemberId" TEXT NOT NULL,
    "creator" JSONB NOT NULL,
    "assigneeMemberId" TEXT,
    "assignmentId" TEXT,
    "reviewerMemberId" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAssignment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "employeeId" TEXT,
    "identity" JSONB NOT NULL,
    "cycle" INTEGER NOT NULL,
    "dueAt" TIMESTAMPTZ(3),
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "endedAt" TIMESTAMPTZ(3),
    "endReason" TEXT,
    "acceptedAt" TIMESTAMPTZ(3),
    "cancelled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "memberId" TEXT NOT NULL,
    "employeeId" TEXT,
    "status" VARCHAR(30) NOT NULL,
    "evidence" JSONB NOT NULL,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedByMemberId" TEXT,
    "reviewReason" VARCHAR(1000),

    CONSTRAINT "TaskAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEntry" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "event" VARCHAR(60) NOT NULL,
    "actor" JSONB NOT NULL,
    "assignmentId" TEXT,
    "attemptId" TEXT,
    "reason" VARCHAR(1000),
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskImage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contentType" VARCHAR(30) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "version" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attachedTo" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskOperation" (
    "userId" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskOperation_pkey" PRIMARY KEY ("userId","key")
);

-- CreateTable
CREATE TABLE "ContactRequest" (
    "id" TEXT NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "businessName" VARCHAR(200) NOT NULL,
    "locations" VARCHAR(300),
    "planInterest" VARCHAR(30),
    "focus" VARCHAR(100),
    "message" VARCHAR(2000),
    "fingerprint" CHAR(64) NOT NULL,
    "retryKey" CHAR(64),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactRateBucket" (
    "key" VARCHAR(100) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ContactRateBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "BusinessTask_businessId_updatedAt_id_idx" ON "BusinessTask"("businessId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "BusinessTask_assigneeMemberId_status_idx" ON "BusinessTask"("assigneeMemberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessTask_businessId_id_key" ON "BusinessTask"("businessId", "id");

-- CreateIndex
CREATE INDEX "TaskAssignment_taskId_assignedAt_id_idx" ON "TaskAssignment"("taskId", "assignedAt", "id");

-- CreateIndex
CREATE INDEX "TaskAssignment_memberId_assignedAt_idx" ON "TaskAssignment"("memberId", "assignedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAssignment_taskId_cycle_key" ON "TaskAssignment"("taskId", "cycle");

-- CreateIndex
CREATE INDEX "TaskAttempt_taskId_submittedAt_id_idx" ON "TaskAttempt"("taskId", "submittedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskAttempt_assignmentId_attemptNumber_key" ON "TaskAttempt"("assignmentId", "attemptNumber");

-- CreateIndex
CREATE INDEX "TaskEntry_taskId_kind_createdAt_id_idx" ON "TaskEntry"("taskId", "kind", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskImage_publicId_key" ON "TaskImage"("publicId");

-- CreateIndex
CREATE INDEX "TaskImage_status_expiresAt_idx" ON "TaskImage"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ContactRequest_fingerprint_createdAt_idx" ON "ContactRequest"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "ContactRequest_retryKey_createdAt_idx" ON "ContactRequest"("retryKey", "createdAt");

-- CreateIndex
CREATE INDEX "ContactRateBucket_expiresAt_idx" ON "ContactRateBucket"("expiresAt");

-- AddForeignKey
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "BusinessTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttempt" ADD CONSTRAINT "TaskAttempt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "BusinessTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskAttempt" ADD CONSTRAINT "TaskAttempt_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "TaskAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEntry" ADD CONSTRAINT "TaskEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "BusinessTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskImage" ADD CONSTRAINT "TaskImage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "BusinessTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Permission" DROP CONSTRAINT "Permission_catalog_check";
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_catalog_check" CHECK ("key" IN ('task:create','task:assign','task:view','task:update','task:review','task:report','inventory:view','inventory:manage','inventory:receive','inventory:checkout','inventory:sales:view','inventory:report','business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage'));
CREATE OR REPLACE FUNCTION protect_system_permissions() RETURNS trigger LANGUAGE plpgsql AS $$
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
   IF NOT ((assigned."key"='owner' AND NEW."permission" IN ('task:create','task:assign','task:view','task:update','task:review','task:report','inventory:view','inventory:manage','inventory:receive','inventory:checkout','inventory:sales:view','inventory:report','business:update','members:invite','members:remove','members:update_role','members:update_status','members:view','roles:view','roles:create','roles:update','roles:delete','roles:assign','payments:create','payments:view','payments:view_own','payments:approve','payments:cancel','providers:create','providers:update','providers:view','invoices:create','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','invoices:view','reports:view','audit_logs:view','employees:view_own','policies:view','policies:create','policies:update','policies:archive','policies:assign','policies:view_audit','policies:reconcile','integrations:view','integrations:manage')) OR (assigned."key"='admin' AND NEW."permission" IN ('task:create','task:assign','task:view','task:update','task:review','task:report','inventory:view','inventory:manage','inventory:receive','inventory:checkout','inventory:sales:view','inventory:report','members:invite','members:view','members:update_status','payments:create','payments:approve','payments:view','providers:create','providers:update','invoices:create','invoices:view','reports:view','audit_logs:view','employee_lists:create','employee_lists:view','employee_lists:update','employee_lists:archive','employees:create','employees:view','employees:update','employees:archive','employees:verify','integrations:view','integrations:manage')) OR (assigned."key"='finance_manager' AND NEW."permission" IN ('inventory:view','inventory:checkout','inventory:sales:view','inventory:report','payments:create','payments:approve','payments:view','providers:create','invoices:create','invoices:view','reports:view','employee_lists:create','employee_lists:view','employee_lists:update','employees:create','employees:view','employees:update','employees:verify','members:view')) OR (assigned."key"='accountant' AND NEW."permission" IN ('inventory:view','inventory:sales:view','inventory:report','payments:view','invoices:view','reports:view','members:view','employee_lists:view','employees:view')) OR (assigned."key"='employee' AND NEW."permission" IN ('employees:view_own','members:view','employee_lists:view','reports:view')) OR (assigned."key"='contributor' AND NEW."permission" IN ('payments:create','members:view','payments:view_own')) OR (assigned."key"='viewer' AND NEW."permission" IN ('payments:view','invoices:view','members:view','reports:view'))) THEN RAISE EXCEPTION 'Permission is not granted to this system role'; END IF;
 END IF;
 RETURN NEW;
END $$;
INSERT INTO "Permission" ("key") VALUES ('task:create'),('task:assign'),('task:view'),('task:update'),('task:review'),('task:report') ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId","permission") SELECT r."id",p."key" FROM "Role" r CROSS JOIN "Permission" p WHERE r."type"='system' AND r."key" IN ('owner','admin') AND p."key" LIKE 'task:%' ON CONFLICT DO NOTHING;
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_domain_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200 AND "revision">0 AND "status" IN ('unassigned','todo','in_progress','in_review','changes_requested','completed','failed','cancelled') AND "priority" IN ('low','normal','high','urgent') AND (NOT "requiresReview" OR "reviewerMemberId" IS NOT NULL) AND ("reviewerMemberId" IS NULL OR "reviewerMemberId" IS DISTINCT FROM "assigneeMemberId") AND (("assignmentId" IS NULL)=("assigneeMemberId" IS NULL)));
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_creator_fkey" FOREIGN KEY ("businessId","createdByMemberId") REFERENCES "BusinessMember"("businessId","id") ON DELETE RESTRICT;
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_assignee_fkey" FOREIGN KEY ("businessId","assigneeMemberId") REFERENCES "BusinessMember"("businessId","id") ON DELETE RESTRICT;
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_reviewer_fkey" FOREIGN KEY ("businessId","reviewerMemberId") REFERENCES "BusinessMember"("businessId","id") ON DELETE RESTRICT;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_domain_check" CHECK ("cycle">0 AND ("endedAt" IS NULL OR "endedAt">="assignedAt") AND ("acceptedAt" IS NULL OR "acceptedAt">="assignedAt"));
CREATE UNIQUE INDEX "TaskAssignment_one_open" ON "TaskAssignment"("taskId") WHERE "endedAt" IS NULL;
ALTER TABLE "TaskAttempt" ADD CONSTRAINT "TaskAttempt_domain_check" CHECK ("attemptNumber">0 AND "status" IN ('submitted','accepted','changes_requested','failed','superseded') AND jsonb_typeof("evidence")='object');
ALTER TABLE "TaskImage" ADD CONSTRAINT "TaskImage_domain_check" CHECK ("sizeBytes" BETWEEN 1 AND 5242880 AND "contentType" IN ('image/jpeg','image/png','image/webp') AND "status" IN ('pending','finalized','attached','deleting','deleted') AND ("attachedTo" IS NULL OR "status"='attached'));
ALTER TABLE "ContactRequest" ADD CONSTRAINT "ContactRequest_domain_check" CHECK ("kind" IN ('contact','demo') AND length(btrim("name"))>0 AND length(btrim("businessName"))>0 AND ("planInterest" IS NULL OR "planInterest" IN ('starter','growth','standard','efficient','unsure')) AND ("focus" IS NULL OR "focus" IN ('Payroll approvals','Inventory logs','Payment security','Batch and expiry tracking')));
CREATE FUNCTION guard_task_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t "BusinessTask"%ROWTYPE; m "BusinessMember"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Task assignments cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
   IF ROW(NEW."taskId",NEW."memberId",NEW."employeeId",NEW."identity",NEW."cycle",NEW."assignedAt") IS DISTINCT FROM ROW(OLD."taskId",OLD."memberId",OLD."employeeId",OLD."identity",OLD."cycle",OLD."assignedAt") OR (OLD."endedAt" IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Assignment history is immutable'; END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO t FROM "BusinessTask" WHERE "id"=NEW."taskId";
 SELECT * INTO m FROM "BusinessMember" WHERE "id"=NEW."memberId";
 IF m."businessId" IS DISTINCT FROM t."businessId" OR m."status"<>'active' OR m."approvalStatus" NOT IN ('approved','not_required') THEN RAISE EXCEPTION 'Ineligible task assignee'; END IF;
 IF NEW."employeeId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "BusinessEmployee" WHERE "id"=NEW."employeeId" AND "businessId"=t."businessId" AND "businessMemberId"=m."id" AND "status"='active') THEN RAISE EXCEPTION 'Ineligible task employee'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TaskAssignment_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TaskAssignment" FOR EACH ROW EXECUTE FUNCTION guard_task_assignment();
CREATE FUNCTION guard_task_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "TaskAssignment"%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Task attempts cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD."status"<>'submitted' OR NEW."status" NOT IN ('accepted','changes_requested','failed','superseded') OR ROW(NEW."taskId",NEW."assignmentId",NEW."attemptNumber",NEW."memberId",NEW."employeeId",NEW."evidence",NEW."submittedAt") IS DISTINCT FROM ROW(OLD."taskId",OLD."assignmentId",OLD."attemptNumber",OLD."memberId",OLD."employeeId",OLD."evidence",OLD."submittedAt") THEN RAISE EXCEPTION 'Submitted evidence is immutable'; END IF;
 ELSE
   SELECT * INTO a FROM "TaskAssignment" WHERE "id"=NEW."assignmentId";
   IF a."taskId" IS DISTINCT FROM NEW."taskId" OR a."memberId" IS DISTINCT FROM NEW."memberId" OR a."employeeId" IS DISTINCT FROM NEW."employeeId" THEN RAISE EXCEPTION 'Attempt assignment identity mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TaskAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TaskAttempt" FOR EACH ROW EXECUTE FUNCTION guard_task_attempt();
CREATE TRIGGER "TaskEntry_immutable" BEFORE UPDATE OR DELETE ON "TaskEntry" FOR EACH ROW EXECUTE FUNCTION reject_inventory_history_mutation();
CREATE FUNCTION guard_attached_task_image() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD."attachedTo" IS NOT NULL THEN RAISE EXCEPTION 'Attached evidence images are immutable'; END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE TRIGGER "TaskImage_guard" BEFORE UPDATE OR DELETE ON "TaskImage" FOR EACH ROW EXECUTE FUNCTION guard_attached_task_image();
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_taskId_id_key" UNIQUE ("taskId","id");
ALTER TABLE "BusinessTask" ADD CONSTRAINT "BusinessTask_current_assignment_fkey" FOREIGN KEY ("id","assignmentId") REFERENCES "TaskAssignment"("taskId","id") ON DELETE RESTRICT;
COMMIT;
