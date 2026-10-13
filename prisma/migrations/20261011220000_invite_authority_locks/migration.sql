BEGIN;
-- Permission mutations take the same parent role lock used by invite/review
-- authorization. This also covers custom grants and explicit denials.
CREATE FUNCTION lock_role_permission_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "id" FROM "Role" WHERE "id" = NEW."roleId" FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "id" FROM "Role" WHERE "id" = OLD."roleId" FOR UPDATE;
  ELSE
    PERFORM "id" FROM "Role" WHERE "id" IN (OLD."roleId", NEW."roleId") ORDER BY "id" FOR UPDATE;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RolePermission_authority_lock" BEFORE INSERT OR UPDATE OR DELETE ON "RolePermission" FOR EACH ROW EXECUTE FUNCTION lock_role_permission_authority();
CREATE TRIGGER "RoleDeniedPermission_authority_lock" BEFORE INSERT OR UPDATE OR DELETE ON "RoleDeniedPermission" FOR EACH ROW EXECUTE FUNCTION lock_role_permission_authority();
ALTER TABLE "InviteEmailDelivery" ADD CONSTRAINT "InviteEmailDelivery_payload_required" CHECK (
  "state" NOT IN ('pending', 'processing') OR "payloadCiphertext" IS NOT NULL
);
ALTER TABLE "InviteEmailDelivery" ADD CONSTRAINT "InviteEmailDelivery_lease_pair" CHECK (
  ("leaseId" IS NULL) = ("leaseExpiresAt" IS NULL)
);
COMMIT;
