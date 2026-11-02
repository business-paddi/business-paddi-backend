# Current user and workspace read caching

Redis stores sanitized current-user data (also reused for preferences) and full
business access snapshots. Existing URLs, cookies, response envelopes and browser
`Cache-Control: no-store` behaviour are unchanged. No frontend change is needed.
`REDIS_URL` is the existing Redis configuration; there is no new provider.

## Freshness and invalidation

`20261102120000_versioned_read_cache` creates `ReadCacheRevision` and database
triggers. Every relevant committed write changes a UUID revision atomically:

| Data changed                                              | Revision changed | Cached data refreshed                                                          |
| --------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| User profile, email, password, status                     | user             | Current user, preferences                                                      |
| UserPreference or AuthProvider insertion/update/deletion  | user             | Current user, preferences                                                      |
| Business details or status                                | business         | All members' workspace access snapshots                                        |
| BusinessMember role, status, approval or other fields     | member           | That membership's access snapshot                                              |
| Role details/status, RolePermission, RoleDeniedPermission | role             | Every membership using that role, including across businesses for system roles |

The session guard still checks the primary database on every request, now using
one SQL join for session revocation, user status and the user revision. This
revision selects the Redis user key without an extra database query. Workspace
access uses one indexed SQL join to read business/member/role revisions before
reading Redis, replacing the repeated loading of business, membership, role,
permissions and denials. Requested permissions are checked on cache hits too.

This deliberately retains small Neon freshness queries. It does **not** provide
zero-database authorization: serving cached access without checking freshness
would allow a revocation window, unless all writers participate in a more complex
distributed invalidation protocol. Removing a member, suspending a business/user,
changing roles or logging out must not depend on Redis expiry.

No controller has to enumerate other members' keys or remember to call `DEL`.
Changes from any backend instance, background job, migration or ordinary direct
SQL write fire the same triggers. Transaction rollback also rolls back its
revision changes. Reads beginning after a commit use the new version. A request
already in progress can finish using its earlier authorized snapshot; mutation
authorization always bypasses Redis and retains the existing transaction locks.
Disabling triggers, truncating the revision table, restoring an older database,
or writing through a replica is outside this guarantee: clear the `bp:read:v1:`
namespace or bump its version before serving traffic after such maintenance.

Keys include the user, business where applicable, record identity and revisions.
An old request finishing after an edit can only fill an old key, never overwrite
the new one. Old keys expire after 300 seconds; this TTL is memory cleanup, not
the invalidation mechanism. The revision table retains one row per scope/entity
(including deleted identities) to prevent reuse of an old version.

## Storage and failures

Server invalidation takes effect on the next request; it does not push new data
into an already-open browser. Frontend mutations should invalidate their current
user/preferences or workspace/business-list React Query entries after success.
Other editors' open pages need a refetch (for example on focus or a timer), or a
future SSE/WebSocket event for immediate display updates. A stale browser display
does not preserve backend access: the next protected request checks fresh state.

The shared global Redis module provides `ReadCacheService`. It uses Node V8
serialization to preserve internal Date values, a five-minute TTL, and coalesces
concurrent misses within each backend process. Independent processes share the
same Redis entries. A cold miss loads Neon; a hit reuses the payload from Redis.
The namespace version must change if the cached internal data shape changes.

Only the public current-user projection is cached: passwords are reduced to
`hasPassword`; tokens, password hashes and session credentials are excluded.
Access snapshots contain only the existing membership, business and role data.
No denied access, missing records or database errors are cached. Redis must remain
private and authenticated using the existing deployment configuration.

Read-cache Redis operations have a 100 ms deadline and fall back to database
reads on disconnect, timeout or corrupt data. Freshness-query failure fails the
request; it never authorizes using a stale cached entry. This fallback applies to
the read cache; Redis-backed sessions, queues and rate limits retain their
existing availability requirements.

## The measured six-second browser wait

Before this change, a signed-in localhost tasks-page reload showed:

| Stage                                | First reload | Second reload |
| ------------------------------------ | -----------: | ------------: |
| Document load event                  |       400 ms |        406 ms |
| Current-user request duration        |     2,563 ms |      1,250 ms |
| Workspace-access request duration    |     2,616 ms |      2,943 ms |
| Task request starts after navigation |     6,204 ms |      5,002 ms |
| Task request duration                |     5,323 ms |      5,216 ms |
| Task data arrives after navigation   |    11,527 ms |     10,218 ms |

The frontend waits for current user before workspace access, then waits for
workspace access before mounting the task board. That dependency chain explains
the five-to-six-second wait before the task request starts. No token refresh
occurred in either trace. These localhost requests used localhost:5000, so Render
was not in that request path. Browser document loading was under half a second.

A separate warmed task-service replay returned one task using 16 SQL queries and
took 4.66 seconds, almost entirely inside Prisma database operations. Individual
warmed Neon `SELECT 1` queries took about 235–251 ms. Redis caching shortens the
user/workspace path, but it does not remove the frontend dependency chain or the
task summary's serial per-task database queries. Next improvements are parallel
task fetching once authentication succeeds, and batching task summary reads.
These are separate from this backend cache change; no frontend files are modified.

After this change, a read-only database/service replay against the same workspace
measured the following. It included the live database session guard, with token
verification stubbed; it excluded browser, HTTP middleware and hydration time.
Redis fills were counted to confirm which requests were cache hits.

| Backend operation                         |       Duration | SQL statements | Redis fills |
| ----------------------------------------- | -------------: | -------------: | ----------: |
| Current user, already cached (three runs) |     305–404 ms |              1 |           0 |
| Workspace access, cold                    |       3,544 ms |              7 |           1 |
| Workspace access, cached (two runs)       |     649–719 ms |              2 |           0 |
| Tasks, with cached access (two runs)      | 3,570–3,593 ms |             13 |           0 |

These confirm that cached user/workspace payloads avoid their repeated full
database loads. They do not establish a new end-to-end page-load time: the
post-change Chrome debugging connection timed out. The remaining task queries and
the frontend request sequence still require separate improvements.

## Verification

Implementation verification: build passed; all 382 unit tests passed across 44
suites; changed-file ESLint passed; 24 real Redis/database integration checks
passed, including cross-instance invalidation, revocation, rollback and TTL.

Run the unit suite and `npm run db:test:read-cache` (requires the existing
`DATABASE_URL` and `REDIS_URL`). The database check uses an isolated test schema,
applies all migrations, tests real Redis hits and committed/rolled-back trigger
invalidation, then removes only its own schema and Redis keys.

Apply migrations before starting the updated backend:

```sh
npx prisma migrate deploy
npm run build
```
