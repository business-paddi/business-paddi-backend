// Narrow fallback for this migration when Neon HTTPS works but TCP deployment
// is unavailable. DDL and the exact Prisma checksum are committed together.
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const migrationName='20261013120000_employee_entered_account_name';
async function main() {
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const source=await readFile(`prisma/migrations/${migrationName}/migration.sql`,'utf8');
  const checksum=createHash('sha256').update(source).digest('hex');
  const sql=neon(process.env.DATABASE_URL,{fetchOptions:{signal:AbortSignal.timeout(30000)}});
  const existing=await sql.query('SELECT checksum,finished_at,rolled_back_at FROM _prisma_migrations WHERE migration_name=$1',[migrationName]);
  if(existing.some(row=>row.finished_at && !row.rolled_back_at)) {
    if(!existing.some(row=>row.finished_at && !row.rolled_back_at && row.checksum===checksum)) throw new Error('Applied migration checksum differs');
    console.log('Employee bank guard migration already applied with matching checksum.');return;
  }
  const ddl=source.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'');
  await sql.transaction([
    sql.query('SELECT pg_advisory_xact_lock(72707369)::text'),
    sql.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL) THEN RAISE EXCEPTION 'Unresolved migration exists'; END IF;
      IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name='20261012120000_tasks_contact' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN RAISE EXCEPTION 'Prerequisite migration missing'; END IF;
      IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name='20261013120000_employee_entered_account_name' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN RAISE EXCEPTION 'Migration state changed; rerun'; END IF;
    END $$`),
    sql.query(ddl),
    sql.query('INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)',[randomUUID(),checksum,migrationName]),
  ]);
  console.log('Employee bank guard and migration checksum committed atomically over HTTPS.');
}
main().catch(error=>{console.error(error instanceof Error?error.name:'Migration failure');process.exitCode=1;});
