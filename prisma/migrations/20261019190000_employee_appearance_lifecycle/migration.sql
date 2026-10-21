-- Additive only: existing employees retain their statuses; existing appearance defaults to NULL.
ALTER TYPE "EmployeeStatus" ADD VALUE IF NOT EXISTS 'scheduled_for_deletion';
ALTER TYPE "EmployeeStatus" ADD VALUE IF NOT EXISTS 'deleted';

ALTER TABLE "EmployeeGroup" ADD COLUMN "color" VARCHAR(7), ADD COLUMN "icon" VARCHAR(32);
ALTER TABLE "EmployeeGroup" ADD CONSTRAINT "EmployeeGroup_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
ALTER TABLE "EmployeeGroup" ADD CONSTRAINT "EmployeeGroup_icon_check" CHECK ("icon" IS NULL OR "icon" IN ('Users','Briefcase','Code','Palette','Heart','ShoppingBag','Building','Shield','GraduationCap','Headphones','Wrench','Package'));

ALTER TABLE "BusinessEmployee"
  ADD COLUMN "deletionScheduledAt" TIMESTAMPTZ(3),
  ADD COLUMN "deletionRequestedAt" TIMESTAMPTZ(3),
  ADD COLUMN "deletionRequestedByUserId" TEXT,
  ADD COLUMN "statusBeforeDeletion" VARCHAR(32),
  ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
CREATE INDEX "BusinessEmployee_status_deletionScheduledAt_idx" ON "BusinessEmployee"("status", "deletionScheduledAt");

-- Use text comparisons so the newly added enum labels are not used as enum literals
-- until this migration commits (Postgres disallows using uncommitted enum labels).
ALTER TABLE "BusinessEmployee" ADD CONSTRAINT "BusinessEmployee_deletion_lifecycle_check" CHECK (
  ("status"::text = 'scheduled_for_deletion' AND "deletionScheduledAt" IS NOT NULL AND "deletionRequestedAt" IS NOT NULL AND "deletionRequestedByUserId" IS NOT NULL AND "statusBeforeDeletion" IS NOT NULL AND "statusBeforeDeletion" IN ('active','suspended','on_leave','archived') AND "deletedAt" IS NULL)
  OR ("status"::text = 'deleted' AND "deletedAt" IS NOT NULL AND "deletionScheduledAt" IS NULL AND "deletionRequestedAt" IS NOT NULL AND "deletionRequestedByUserId" IS NOT NULL AND "statusBeforeDeletion" IS NOT NULL AND "statusBeforeDeletion" IN ('active','suspended','on_leave','archived'))
  OR ("status"::text NOT IN ('scheduled_for_deletion','deleted') AND "deletionScheduledAt" IS NULL AND "deletionRequestedAt" IS NULL AND "deletionRequestedByUserId" IS NULL AND "statusBeforeDeletion" IS NULL AND "deletedAt" IS NULL)
);

CREATE FUNCTION employee_group_appearance_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT := nullif(current_setting('business_paddi.actor_id',true),''); before_value JSONB := NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."color" IS NULL AND NEW."icon" IS NULL THEN RETURN NEW; END IF;
  ELSE
    IF ROW(NEW."color",NEW."icon") IS NOT DISTINCT FROM ROW(OLD."color",OLD."icon") THEN RETURN NEW; END IF;
    before_value := jsonb_build_object('color',OLD."color",'icon',OLD."icon");
  END IF;
  PERFORM record_business_activity(NEW."businessId",actor,'business.employee_group.appearance_changed',NEW."id",jsonb_build_object('groupId',NEW."id"),jsonb_build_object('before',before_value,'after',jsonb_build_object('color',NEW."color",'icon',NEW."icon")));
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeGroup_appearance_activity" AFTER INSERT OR UPDATE ON "EmployeeGroup" FOR EACH ROW EXECUTE FUNCTION employee_group_appearance_events();
