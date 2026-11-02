CREATE TABLE "ReadCacheRevision" (
  "scope" VARCHAR(20) NOT NULL,
  "entityId" TEXT NOT NULL,
  "revision" UUID NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT "ReadCacheRevision_pkey" PRIMARY KEY ("scope", "entityId")
);

-- No Redis side effects inside a transaction: rollback also rolls back invalidation.
-- Handle old and new owners when a related record is reassigned.
CREATE FUNCTION bump_read_cache_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_id TEXT;
  next_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    previous_id := to_jsonb(OLD)->>TG_ARGV[1];
  END IF;
  IF TG_OP <> 'DELETE' THEN
    next_id := to_jsonb(NEW)->>TG_ARGV[1];
  END IF;
  IF previous_id IS NOT NULL AND previous_id IS DISTINCT FROM next_id THEN
    INSERT INTO "ReadCacheRevision" ("scope", "entityId")
    VALUES (TG_ARGV[0], previous_id)
    ON CONFLICT ("scope", "entityId") DO UPDATE SET "revision" = gen_random_uuid();
  END IF;
  IF next_id IS NOT NULL THEN
    INSERT INTO "ReadCacheRevision" ("scope", "entityId")
    VALUES (TG_ARGV[0], next_id)
    ON CONFLICT ("scope", "entityId") DO UPDATE SET "revision" = gen_random_uuid();
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER user_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "User"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('user', 'id');
CREATE TRIGGER preferences_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "UserPreference"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('user', 'userId');
CREATE TRIGGER provider_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "AuthProvider"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('user', 'userId');
CREATE TRIGGER business_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "Business"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('business', 'id');
CREATE TRIGGER member_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "BusinessMember"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('member', 'id');
CREATE TRIGGER role_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "Role"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('role', 'id');
CREATE TRIGGER grant_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "RolePermission"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('role', 'roleId');
CREATE TRIGGER denial_read_cache_revision AFTER INSERT OR UPDATE OR DELETE ON "RoleDeniedPermission"
FOR EACH ROW EXECUTE FUNCTION bump_read_cache_revision('role', 'roleId');

-- TRUNCATE does not run row triggers. Broad invalidation covers bulk maintenance.
CREATE FUNCTION bump_all_read_cache_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ReadCacheRevision" SET "revision" = gen_random_uuid() WHERE "scope" = TG_ARGV[0];
  RETURN NULL;
END;
$$;
CREATE TRIGGER preferences_read_cache_truncate AFTER TRUNCATE ON "UserPreference"
FOR EACH STATEMENT EXECUTE FUNCTION bump_all_read_cache_revisions('user');
CREATE TRIGGER provider_read_cache_truncate AFTER TRUNCATE ON "AuthProvider"
FOR EACH STATEMENT EXECUTE FUNCTION bump_all_read_cache_revisions('user');
CREATE TRIGGER grant_read_cache_truncate AFTER TRUNCATE ON "RolePermission"
FOR EACH STATEMENT EXECUTE FUNCTION bump_all_read_cache_revisions('role');
CREATE TRIGGER denial_read_cache_truncate AFTER TRUNCATE ON "RoleDeniedPermission"
FOR EACH STATEMENT EXECUTE FUNCTION bump_all_read_cache_revisions('role');

-- Existing rows also need revisions, including for statement-level invalidation.
INSERT INTO "ReadCacheRevision" ("scope", "entityId")
SELECT 'user', "id" FROM "User"
UNION ALL SELECT 'business', "id" FROM "Business"
UNION ALL SELECT 'member', "id" FROM "BusinessMember"
UNION ALL SELECT 'role', "id" FROM "Role"
ON CONFLICT ("scope", "entityId") DO NOTHING;
