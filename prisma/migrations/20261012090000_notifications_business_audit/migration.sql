BEGIN;
DROP INDEX "UserNotification_inviteId_key";
ALTER TABLE "UserNotification" ALTER COLUMN "inviteId" DROP NOT NULL,
 ADD COLUMN "businessId" TEXT, ADD COLUMN "title" VARCHAR(200), ADD COLUMN "message" VARCHAR(1000),
 ADD COLUMN "actionUrl" VARCHAR(500), ADD COLUMN "data" JSONB, ADD COLUMN "eventKey" VARCHAR(200);
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "UserNotification_userId_eventKey_key" ON "UserNotification"("userId","eventKey");
CREATE UNIQUE INDEX "UserNotification_original_invite_unique" ON "UserNotification"("userId","inviteId") WHERE "type"='business_invite';
CREATE INDEX "UserNotification_inviteId_idx" ON "UserNotification"("inviteId");
CREATE INDEX "UserNotification_userId_readAt_createdAt_idx" ON "UserNotification"("userId","readAt","createdAt");
ALTER TABLE "AuditEvent" ADD COLUMN "businessId" TEXT;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT;
CREATE INDEX "AuditEvent_businessId_createdAt_eventId_idx" ON "AuditEvent"("businessId","createdAt" DESC,"eventId");

-- Durable delivery into the in-app inbox. Per-user event keys deduplicate fanout.
CREATE FUNCTION notify_account(recipient TEXT, kind TEXT, event_key TEXT, heading TEXT, body TEXT, destination TEXT, tenant TEXT DEFAULT NULL, details JSONB DEFAULT '{}'::jsonb) RETURNS void LANGUAGE sql AS $$
 INSERT INTO "UserNotification" ("id","userId","type","eventKey","title","message","actionUrl","businessId","data")
 SELECT gen_random_uuid()::text, recipient, kind, left(event_key,200), left(heading,200), left(body,1000), left(destination,500), tenant, details
 WHERE EXISTS (SELECT 1 FROM "User" WHERE "id"=recipient AND "status"='active')
 ON CONFLICT ("userId","eventKey") DO NOTHING;
$$;
CREATE FUNCTION authorized_business_recipients(tenant TEXT, required TEXT[]) RETURNS TABLE("userId" TEXT) LANGUAGE sql STABLE AS $$
 SELECT m."userId" FROM "BusinessMember" m JOIN "Role" r ON r."id"=m."roleId" JOIN "User" u ON u."id"=m."userId" JOIN "Business" b ON b."id"=m."businessId"
 WHERE m."businessId"=tenant AND m."status"='active' AND r."status"='active' AND u."status"='active' AND u."emailVerifiedAt" IS NOT NULL AND b."status"='active'
 AND NOT EXISTS (SELECT 1 FROM unnest(required) p WHERE NOT EXISTS (SELECT 1 FROM "RolePermission" g WHERE g."roleId"=r."id" AND g."permission"=p) OR EXISTS (SELECT 1 FROM "RoleDeniedPermission" d WHERE d."roleId"=r."id" AND d."permission"=p));
$$;
CREATE FUNCTION record_business_activity(tenant TEXT, actor TEXT, kind TEXT, entity TEXT, details JSONB DEFAULT '{}'::jsonb, changed JSONB DEFAULT '{}'::jsonb, event_outcome "AuditOutcome" DEFAULT 'success', event_severity "AuditSeverity" DEFAULT 'info') RETURNS void LANGUAGE sql AS $$
 INSERT INTO "AuditEvent" ("eventId","businessId","userId","eventType","category","outcome","severity","metadata","changes")
 VALUES(gen_random_uuid()::text,tenant,actor,kind,'business',event_outcome,event_severity,jsonb_build_object('entityId',entity,'actorName',(SELECT "name" FROM "User" WHERE "id"=actor)) || details,changed);
$$;

CREATE FUNCTION business_invite_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT := nullif(current_setting('business_paddi.actor_id',true),''); kind TEXT;
BEGIN
 IF TG_OP='INSERT' THEN kind := 'business.invite.created'; actor := NEW."invitedByUserId";
 ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN kind := 'business.invite.' || NEW."status"::text;
 ELSIF NEW."deliveryGeneration" IS DISTINCT FROM OLD."deliveryGeneration" THEN kind := 'business.invite.resent';
 ELSE RETURN NEW; END IF;
 PERFORM record_business_activity(NEW."businessId",actor,kind,NEW."id",jsonb_build_object('roleId',NEW."roleId",'requiresApproval',NEW."requiresApproval"));
 IF TG_OP='UPDATE' AND NEW."status"='accepted' AND OLD."status"<>'accepted' THEN
  PERFORM notify_account(NEW."invitedByUserId",'business_invite_accepted','invite.accepted/'||NEW."id",'Invitation accepted','Your business invitation was accepted.','/business/'||NEW."businessId"||'/members',NEW."businessId",jsonb_build_object('inviteId',NEW."id"));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BusinessInvite_activity" AFTER INSERT OR UPDATE ON "BusinessInvite" FOR EACH ROW EXECUTE FUNCTION business_invite_events();

CREATE FUNCTION membership_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT := nullif(current_setting('business_paddi.actor_id',true),''); target_grants TEXT[]; recipient TEXT; event_id TEXT := gen_random_uuid()::text; kind TEXT; invitation TEXT;
BEGIN
 IF TG_OP='INSERT' THEN kind := 'business.member.created';
 ELSIF NEW."approvalStatus" IS DISTINCT FROM OLD."approvalStatus" THEN kind := 'business.member.approval_' || NEW."approvalStatus"::text;
 ELSIF NEW."roleId" IS DISTINCT FROM OLD."roleId" THEN kind := 'business.member.role_changed';
 ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN kind := 'business.member.status_changed';
 ELSE RETURN NEW; END IF;
 actor := coalesce(actor,NEW."approvalReviewedByUserId",NEW."statusUpdatedByUserId",NEW."roleUpdatedByUserId",NEW."invitedByUserId");
 PERFORM record_business_activity(NEW."businessId",actor,kind,NEW."id",jsonb_build_object('roleId',NEW."roleId",'memberUserId',NEW."userId"),jsonb_build_object('status',NEW."status",'approvalStatus',NEW."approvalStatus"));
 SELECT i."id" INTO invitation FROM "BusinessInvite" i JOIN "User" u ON u."email"=i."email" WHERE u."id"=NEW."userId" AND i."businessId"=NEW."businessId" AND i."roleId"=NEW."roleId" ORDER BY i."createdAt" DESC LIMIT 1;
 IF NEW."approvalStatus"='pending' AND (TG_OP='INSERT' OR OLD."approvalStatus"<>'pending') THEN
  SELECT array_agg(g."permission") INTO target_grants FROM "RolePermission" g WHERE g."roleId"=NEW."roleId" AND NOT EXISTS (SELECT 1 FROM "RoleDeniedPermission" d WHERE d."roleId"=NEW."roleId" AND d."permission"=g."permission");
  FOR recipient IN SELECT "userId" FROM authorized_business_recipients(NEW."businessId", ARRAY['roles:assign'] || coalesce(target_grants,ARRAY[]::text[])) LOOP
   PERFORM notify_account(recipient,'membership_approval_requested','member.review/'||event_id,'Membership approval needed','A membership is awaiting your review.','/business/'||NEW."businessId"||'/members',NEW."businessId",jsonb_build_object('memberId',NEW."id",'inviteId',invitation));
  END LOOP;
 ELSIF TG_OP='UPDATE' AND OLD."approvalStatus"='pending' AND NEW."approvalStatus" IN ('approved','rejected') THEN
  PERFORM notify_account(NEW."userId",'membership_'||NEW."approvalStatus"::text,'member.reviewed/'||event_id,CASE WHEN NEW."approvalStatus"='approved' THEN 'Membership approved' ELSE 'Membership rejected' END, CASE WHEN NEW."approvalStatus"='approved' THEN 'Your business membership was approved.' ELSE 'Your business membership was rejected.'||coalesce(' Reason: '||NEW."approvalReason",'') END,'/dashboard/invites'||coalesce('?inviteId='||invitation,''),NEW."businessId",jsonb_build_object('memberId',NEW."id",'inviteId',invitation,'approvalStatus',NEW."approvalStatus"));
 ELSIF TG_OP='UPDATE' THEN
  PERFORM notify_account(NEW."userId",'membership_access_changed','member.access/'||event_id,'Business access changed','Your role or membership status has changed.','/dashboard',NEW."businessId",jsonb_build_object('memberId',NEW."id",'status',NEW."status",'roleId',NEW."roleId"));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BusinessMember_activity" AFTER INSERT OR UPDATE ON "BusinessMember" FOR EACH ROW EXECUTE FUNCTION membership_events();

CREATE FUNCTION employee_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT := nullif(current_setting('business_paddi.actor_id',true),''); changed JSONB := '{}'::jsonb; bank_changed BOOLEAN := false; pay_changed BOOLEAN := false; recipient TEXT; linked_user TEXT; event_id TEXT := gen_random_uuid()::text;
BEGIN
 IF TG_OP='UPDATE' THEN
  bank_changed := ROW(NEW."bankCode",NEW."bankName",NEW."accountNumber",NEW."accountName") IS DISTINCT FROM ROW(OLD."bankCode",OLD."bankName",OLD."accountNumber",OLD."accountName");
  pay_changed := ROW(NEW."amount",NEW."payFrequency",NEW."currency") IS DISTINCT FROM ROW(OLD."amount",OLD."payFrequency",OLD."currency");
  IF NOT bank_changed AND NOT pay_changed AND ROW(NEW."fullName",NEW."email",NEW."state",NEW."jobTitle",NEW."status",NEW."employeeTypeId",NEW."managerEmployeeId",NEW."businessMemberId") IS NOT DISTINCT FROM ROW(OLD."fullName",OLD."email",OLD."state",OLD."jobTitle",OLD."status",OLD."employeeTypeId",OLD."managerEmployeeId",OLD."businessMemberId") THEN RETURN NEW; END IF;
  changed := jsonb_build_object('bankDetailsChanged',bank_changed,'compensationChanged',pay_changed);
 END IF;
 PERFORM record_business_activity(NEW."businessId",actor,CASE WHEN TG_OP='INSERT' THEN 'business.employee.created' ELSE 'business.employee.updated' END,NEW."id",'{}',changed);
 IF bank_changed OR pay_changed THEN
  SELECT "userId" INTO linked_user FROM "BusinessMember" WHERE "id"=NEW."businessMemberId" AND "businessId"=NEW."businessId";
  FOR recipient IN SELECT "userId" FROM authorized_business_recipients(NEW."businessId",ARRAY['employees:view','employees:update']) WHERE "userId" IS DISTINCT FROM actor UNION SELECT linked_user WHERE linked_user IS NOT NULL LOOP
   PERFORM notify_account(recipient,'employee_financial_details_changed','employee.financial/'||NEW."id"||'/'||pg_current_xact_id()::text,'Employee payment details changed','Bank or compensation details were updated.','/business/'||NEW."businessId"||'/employees',NEW."businessId",jsonb_build_object('employeeId',NEW."id",'bankDetailsChanged',bank_changed,'compensationChanged',pay_changed));
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "BusinessEmployee_activity" AFTER INSERT OR UPDATE ON "BusinessEmployee" FOR EACH ROW EXECUTE FUNCTION employee_events();

CREATE FUNCTION inventory_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient TEXT;
BEGIN
 IF TG_TABLE_NAME='InventoryMovement' THEN
  PERFORM record_business_activity(NEW."businessId",NEW."actorId",'business.inventory.'||NEW."action",NEW."id",jsonb_build_object('productId',NEW."productId",'saleId',NEW."saleId",'receiptId',NEW."receiptId"));
 ELSE
  FOR recipient IN SELECT "userId" FROM authorized_business_recipients(NEW."businessId",ARRAY['inventory:view','inventory:manage']) LOOP
   PERFORM notify_account(recipient,'inventory_shortage','inventory.shortage/'||NEW."id",CASE WHEN NEW."classification"='out_of_stock' THEN 'Product out of stock' ELSE 'Low stock alert' END,'A product needs replenishment.','/business/'||NEW."businessId"||'/inventory/products/'||NEW."productId",NEW."businessId",jsonb_build_object('productId',NEW."productId",'classification',NEW."classification"));
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "InventoryMovement_activity" AFTER INSERT ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION inventory_events();
CREATE TRIGGER "InventoryShortage_notification" AFTER INSERT ON "InventoryShortage" FOR EACH ROW EXECUTE FUNCTION inventory_events();

CREATE FUNCTION invite_delivery_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation "BusinessInvite"%ROWTYPE;
BEGIN
 IF NEW."state" IN ('failed','uncertain') AND NEW."state" IS DISTINCT FROM OLD."state" THEN
  SELECT * INTO invitation FROM "BusinessInvite" WHERE "id"=NEW."inviteId";
  PERFORM record_business_activity(invitation."businessId",NULL,'business.invite.delivery_failed',invitation."id",jsonb_build_object('deliveryId',NEW."id",'state',NEW."state"),'{}','failure','warning');
  IF invitation."status" <> 'pending' THEN RETURN NEW; END IF;
  PERFORM notify_account(invitation."invitedByUserId",'invite_delivery_failed','invite.delivery/'||NEW."id",'Invitation email needs attention',CASE WHEN NEW."state"='uncertain' THEN 'Delivery could not be confirmed. Reconcile it before sending again.' ELSE 'Invitation email delivery failed.' END,'/business/'||invitation."businessId"||'/members',invitation."businessId",jsonb_build_object('inviteId',invitation."id",'deliveryId',NEW."id",'state',NEW."state"));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "InviteEmailDelivery_notification" AFTER UPDATE ON "InviteEmailDelivery" FOR EACH ROW EXECUTE FUNCTION invite_delivery_events();

CREATE FUNCTION account_security_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE label TEXT; key TEXT := 'security/'||NEW."eventId";
BEGIN
 IF NEW."userId" IS NULL THEN RETURN NEW; END IF;
 CASE NEW."eventType"
  WHEN 'account.password.changed' THEN label := 'Your password was changed';
  WHEN 'account.email.changed' THEN label := 'Your email address was changed';
  WHEN 'account.auth_provider.google_linked' THEN label := 'Google was linked to your account';
  WHEN 'authentication.password_reset.completed' THEN label := 'Your password was reset';
  WHEN 'security.refresh_token.replay_detected' THEN label := 'Suspicious session activity detected'; key := 'security.replay/'||coalesce(NEW."userSessionId",NEW."eventId");
  WHEN 'authentication.login.succeeded' THEN
   IF NEW."userAgent" IS NOT NULL AND EXISTS(SELECT 1 FROM "UserSession" WHERE "userId"=NEW."userId" AND "userSessionId" IS DISTINCT FROM NEW."userSessionId") AND NOT EXISTS(SELECT 1 FROM "UserSession" WHERE "userId"=NEW."userId" AND "userSessionId" IS DISTINCT FROM NEW."userSessionId" AND "userAgent"=NEW."userAgent") THEN label := 'Sign-in from a new browser'; key := 'security.browser/'||NEW."userId"||'/'||md5(NEW."userAgent"); END IF;
  ELSE RETURN NEW;
 END CASE;
 IF label IS NOT NULL THEN PERFORM notify_account(NEW."userId",'account_security',key,label,'Review your account security if this was not you.','/dashboard/settings/security',NULL,jsonb_build_object('eventType',NEW."eventType",'auditEventId',NEW."eventId")); END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION two_factor_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='INSERT' AND NEW."twoFactorEnabled") OR (TG_OP='UPDATE' AND NEW."twoFactorEnabled" IS DISTINCT FROM OLD."twoFactorEnabled") THEN
  PERFORM notify_account(NEW."userId",'account_security','security.twofactor/'||NEW."userId"||'/'||pg_current_xact_id()::text,'Two-factor authentication settings changed','Review your security settings if this was not you.','/dashboard/settings/security',NULL,jsonb_build_object('eventType','account.two_factor.changed'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "UserPreference_security_notification" AFTER INSERT OR UPDATE ON "UserPreference" FOR EACH ROW EXECUTE FUNCTION two_factor_notification();
CREATE TRIGGER "AuditEvent_security_notification" AFTER INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION account_security_notifications();

-- Routine business/configuration changes are audited, never broadcast as alerts.
CREATE FUNCTION business_record_events() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data JSONB; old_data JSONB; tenant TEXT; actor TEXT := nullif(current_setting('business_paddi.actor_id',true),''); entity TEXT; kind TEXT; affected_role TEXT; recipient TEXT; event_id TEXT := gen_random_uuid()::text;
BEGIN
 row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); IF row_data - 'updatedAt' = old_data - 'updatedAt' THEN RETURN NEW; END IF; END IF;
 tenant := row_data->>'businessId'; entity := coalesce(row_data->>'id',row_data->>'employeeId');
 IF TG_TABLE_NAME='Business' THEN tenant := row_data->>'id'; END IF;
 IF TG_TABLE_NAME IN ('RolePermission','RoleDeniedPermission') THEN SELECT "businessId" INTO tenant FROM "Role" WHERE "id"=row_data->>'roleId'; entity := row_data->>'roleId'; END IF;
 IF tenant IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
 kind := CASE TG_TABLE_NAME WHEN 'Business' THEN 'business' WHEN 'Role' THEN 'business.role' WHEN 'RolePermission' THEN 'business.role.grant' WHEN 'RoleDeniedPermission' THEN 'business.role.denial' WHEN 'EmployeeTaxProfile' THEN 'business.employee.tax' WHEN 'BusinessEmployeeGroup' THEN 'business.employee.group' WHEN 'EmployeeType' THEN 'business.employee_type' ELSE 'business.employee_group' END || CASE TG_OP WHEN 'INSERT' THEN '.created' WHEN 'DELETE' THEN '.deleted' ELSE '.updated' END;
 PERFORM record_business_activity(tenant,actor,kind,entity,jsonb_strip_nulls(jsonb_build_object('employeeId',row_data->>'employeeId','groupId',row_data->>'groupId','permission',row_data->>'permission')));
 IF TG_TABLE_NAME IN ('Role','RolePermission','RoleDeniedPermission') THEN
  affected_role := CASE WHEN TG_TABLE_NAME='Role' THEN row_data->>'id' ELSE row_data->>'roleId' END;
  FOR recipient IN SELECT "userId" FROM "BusinessMember" WHERE "businessId"=tenant AND "roleId"=affected_role AND "status" IN ('active','suspended') LOOP
   PERFORM notify_account(recipient,'membership_access_changed','role.access/'||affected_role||'/'||pg_current_xact_id()::text,'Business role changed','Your business role or its permissions were changed.','/dashboard',tenant,jsonb_build_object('roleId',affected_role));
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER "Business_activity" AFTER INSERT OR UPDATE ON "Business" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "Role_activity" AFTER INSERT OR UPDATE OR DELETE ON "Role" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "RolePermission_activity" AFTER INSERT OR UPDATE OR DELETE ON "RolePermission" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "RoleDeniedPermission_activity" AFTER INSERT OR UPDATE OR DELETE ON "RoleDeniedPermission" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "EmployeeTaxProfile_activity" AFTER INSERT OR UPDATE ON "EmployeeTaxProfile" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "BusinessEmployeeGroup_activity" AFTER INSERT OR DELETE ON "BusinessEmployeeGroup" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "EmployeeType_activity" AFTER INSERT OR UPDATE ON "EmployeeType" FOR EACH ROW EXECUTE FUNCTION business_record_events();
CREATE TRIGGER "EmployeeGroup_activity" AFTER INSERT OR UPDATE ON "EmployeeGroup" FOR EACH ROW EXECUTE FUNCTION business_record_events();
COMMIT;
