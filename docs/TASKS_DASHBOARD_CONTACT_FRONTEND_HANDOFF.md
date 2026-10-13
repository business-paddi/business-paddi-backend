# Tasks, dashboard, analytics and public contact: backend contract

This document supersedes the proposed task/contact contract. Paths below include `/api`; do not add the prefix twice if the frontend client supplies it. No frontend files were changed. The existing inventory, invite, notifications and audit APIs remain available.

## Decisions to use in the frontend

- Exact permissions: `task:create`, `task:assign`, `task:view`, `task:update`, `task:review`, `task:report`. Owner/admin system roles receive all six. Custom roles use the existing grants/denials API. Authorize with effective permissions, never a role name.
- `task:view` grants business-wide visibility. Without it, creators see their own tasks, assignees see their current tasks, and eligible designated reviewers see their review tasks. Update/review grants alone do not make every task visible. `task:report` grants business-wide analytics independently.
- Creation without assignment needs `task:create`; assigned creation additionally needs `task:assign`. No-review creation/update additionally needs `task:review`.
- Review-required tasks require an **explicit** `reviewerMemberId`, including unassigned tasks. Reviewer must be an active eligible member with `task:review`, different from the assignee. Only the designated reviewer can decide a pending attempt. A manager can change the reviewer while review is pending, but cannot switch off review to bypass it.
- One current assignee; member is canonical. `employeeId` is optional, and must reference that member's active linked employee. Selecting a member directly does not silently associate an employee. Archival/unlinking does not change old assignment identities; reassignment is explicit.
- Task edits, assignments, start, submissions, reviews, reopen, cancel **and comments** require expected `revision`. Comments add this field to the originally proposed body. Draft image endpoints do not change task revision.
- Required `Idempotency-Key` on task creation, submissions and comments. Printable non-whitespace ASCII, 1–100 characters. Keys are scoped to the authenticated user across these operations and retained indefinitely; never reuse a key for another operation. Same body/key replays the original task/result snapshot; changed body or route returns 409. Image read URLs refresh on replay. GET task detail after a replay if current state is needed.
- Evidence images use **Cloudinary authenticated storage**, not public product image strings. Upload intents include additional `fields` for a multipart upload. Cookie-authenticated backend image reads expire after 15 minutes and recheck current task access.
- Notes-only and links-only submissions are supported. Do not invent evidence requirements or let a user directly patch status.
- Scheduled reminders use the existing stored notification inbox; there are no task emails or public contact confirmation emails.

## Authentication and requests

Task/dashboard/analytics/image endpoints use existing `accessToken` cookies and `AccessTokenGuard`. The account must remain active and verified, session unrevoked, business active and membership/role active, with membership approval `approved` or `not_required`. Browser API calls use `credentials: 'include'`; preserve the existing auth refresh flow and auth redirects. Mutation origins must match configured `FRONTEND_URL`, using the existing CSRF middleware. CORS permits that origin with credentials. Do not send user IDs or actors in bodies.

Public contact uses no cookies and no auth refresh. The existing approved-origin check still applies to browser mutations. Production proxy settings must trust only the actual upstream proxies so client IP rate limits cannot be spoofed. The Express JSON request limit is 100 KB; field limits below are stricter.

All dates are UTC ISO strings on the wire, nullable fields are explicit null, IDs/cursors are opaque. Send decimal-independent integer revisions. Preserve form drafts after 409; refresh detail and ask the user to reconcile the change rather than automatically overwriting it. Read endpoints have `Cache-Control: no-store`.

## Routes

| Method | Path | Body/query | Result |
|---|---|---|---|
| GET | `/api/businesses/:businessId/tasks` | Task filters below | `{items, nextCursor}` |
| POST | `/api/businesses/:businessId/tasks` | Create body; retry key | 201 `{task}` |
| GET | `/api/businesses/:businessId/tasks/:taskId` | — | `{task}` detail |
| PATCH | `/api/businesses/:businessId/tasks/:taskId` | `{revision,title?,description?,priority?,dueAt?,requiresReview?,reviewerMemberId?}` | `{task}` |
| GET | `/api/businesses/:businessId/task-assignees` | `q,kind=member|employee|all,limit,cursor` | `{items,nextCursor}` |
| GET | `/api/businesses/:businessId/task-reviewers` | `q,assigneeMemberId?,limit,cursor` | `{items:[{memberId,userId,name,avatar}],nextCursor}`; create/assign/update/review holders, eligible reviewers only; excludes selected assignee |
| POST | `/api/businesses/:businessId/tasks/:taskId/assignments` | `{revision,assigneeMemberId,employeeId?,reason?}` | 200 `{task,assignment}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/start` | `{revision}` | 200 `{task}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/submissions` | `{revision,notes?,links?,imageIds?}`; retry key | 200 `{task,attempt}` |
| GET | `/api/businesses/:businessId/tasks/:taskId/attempts` | `limit,cursor` | `{items,nextCursor}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/attempts/:attemptId/review` | `{revision,decision:'accept'|'request_changes'|'fail',reason?}` | 200 `{task,attempt}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/reopen` | `{revision,reason}` | 200 `{task,assignment?}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/cancel` | `{revision,reason}` | 200 `{task}` |
| GET | `/api/businesses/:businessId/tasks/:taskId/history` | `limit,cursor` | `{items,nextCursor}` |
| GET | `/api/businesses/:businessId/tasks/:taskId/assignments` | `limit,cursor` | `{items,nextCursor}`; additional full assignment-history endpoint |
| GET | `/api/businesses/:businessId/tasks/:taskId/comments` | `limit,cursor` | `{items,nextCursor}` |
| POST | `/api/businesses/:businessId/tasks/:taskId/comments` | `{revision,notes?,links?,imageIds?}`; retry key | 201 `{task,comment}` |
| GET | `/api/dashboard/tasks` | Task filters and `businessId,scope` | `{items,nextCursor,summary}` |
| GET | `/api/businesses/:businessId/task-analytics` | Analytics query below | `{period,definitions,totals,items,nextCursor}` |

Task filters: `limit` default 30/max 100 (dashboard default 10), `cursor`, `q` max 200, `status`, `priority`, `assigneeMemberId`, `employeeId`, `createdByMemberId`, `overdue=true|false`, `dueFrom`, `dueTo`, `sort=updatedAt_desc|dueAt_asc`. Dashboard supports `businessId` and `scope=visible|assigned_to_me|created_by_me`, default visible. Due bounds are `[dueFrom,dueTo)`. Default order updatedAt DESC, id DESC; deadline order dueAt ASC NULLS LAST, id ASC. Task payload timestamps/id are the sort keys. Employee filtering uses the **current assignment**, including completed assignments.

Collection pagination defaults 30/max 100. Attempts order submittedAt DESC/id DESC; entries createdAt DESC/id DESC; assignments assignedAt DESC/id DESC; assignees memberId ASC; analytics identity ID ASC. Cursors are signed and bound to actor, route and filters. Reusing one with changed filters returns `INVALID_CURSOR` 400. Page size may change. Concurrent updates may move tasks between pages; refresh the first page after mutations. Never derive global counts from loaded items.

```ts
type TaskStatus = 'unassigned'|'todo'|'in_progress'|'in_review'
  |'changes_requested'|'completed'|'failed'|'cancelled';
type Identity = {
  memberId:string; userId:string; name:string; avatar:string|null;
  employeeId:string|null; employeeName:string|null; employeePhoto:string|null;
};
type TaskSummary = {
  id:string; businessId:string; title:string; status:TaskStatus;
  priority:'low'|'normal'|'high'|'urgent'; dueAt:string|null;
  createdAt:string; updatedAt:string; completedAt:string|null; revision:number;
  business:{id:string;name:string;profileImage:string|null};
  createdBy:Identity; assignee:Identity|null; assignmentId:string|null;
  requiresReview:boolean; reviewerMemberId:string|null;
  attemptCount:number; latestAttemptStatus:TaskAttempt['status']|null;
  isOverdue:boolean; viewerRelation:'assignee'|'creator'|'manager';
  capabilities:{canEdit:boolean;canAssign:boolean;canStart:boolean;
    canSubmit:boolean;canReview:boolean;canReopen:boolean;
    canCancel:boolean;canComment:boolean};
};
type Image = {id:string;name:string;contentType:string;sizeBytes:number;
  width:number;height:number;url:string;urlExpiresAt:string};
type Evidence = {notes:string|null;links:{label:string|null;url:string}[];images:Image[]};
type TaskAttempt = {
  id:string; taskId:string; assignmentId:string; attemptNumber:number;
  memberId:string; employeeId:string|null;
  status:'submitted'|'accepted'|'changes_requested'|'failed'|'superseded';
  evidence:Evidence; submittedAt:string; reviewedAt:string|null;
  reviewedByMemberId:string|null; reviewReason:string|null;
};
type Assignment = {
  id:string;taskId:string;memberId:string;employeeId:string|null;identity:Identity;
  cycle:number;dueAt:string|null;assignedAt:string;startedAt:string|null;
  endedAt:string|null;endReason:string|null;acceptedAt:string|null;cancelled:boolean;
};
type TaskDetail = TaskSummary & {description:string|null;
  assignmentHistory:Assignment[];assignmentHistoryHasMore:boolean;
  latestAttempt:TaskAttempt|null};
type Comment = Evidence & {id:string;author:Identity;createdAt:string};
type History = {id:string;taskId:string;kind:'history';event:string;actor:Identity;
  assignmentId:string|null;attemptId:string|null;reason:string|null;
  data:Record<string,unknown>;createdAt:string};
```

Task cards/assignment history preserve identity snapshots from their assignment. They do not silently adopt new employee links. Do not assume employee fields are populated for every member. All payloads omit payroll, bank and tax fields.

Creation example:

```json
{"title":"Review checkout accessibility","description":"Test mobile checkout.","priority":"normal","dueAt":"2026-10-16T16:00:00Z","assigneeMemberId":"member-id","employeeId":"linked-employee-id","requiresReview":true,"reviewerMemberId":"reviewer-id"}
```

Omit both assignment fields for an unassigned task; default requiresReview is true. Nullable description/deadline/reviewer can be cleared with null, subject to reviewer-required validation. Assignee/status cannot be patched. Reassignment requires a reason and cannot duplicate the current member/employee pair. Reassignment supersedes only the pending submitted attempt; previously failed/rejected/accepted attempts remain unchanged. Reviews act on the current pending attempt and current revision only. Changes/failure require reasons. Request changes permits another attempt in the same cycle; failure requires explicit reassignment or reopen. Reopen completed/failed work creates a new cycle; an ineligible old recipient leaves the task unassigned. Cancel preserves history and excludes its current assignment from completion-rate denominator. Comments never complete work.

Limits: title 1–200; description/notes max 10,000; reasons 1–1,000; 10 links and 10 unique finalized images per evidence object. At least one meaningful evidence field is required. Links must be absolute HTTP(S); render plain text and safe links, never fetch previews automatically. Assignee picker returns active eligible accounts/members, with an active linked employee only when one exists; it does not require members:view/employees:view. `kind=all` returns one row per member and includes their active employee identity; `kind=member` omits the employee association; `kind=employee` includes only linked active employees.

## Dashboard

`summary` covers all tasks matching the authorized filters, before pagination:

```ts
type DashboardSummary = {visibleCount:number;assignedToMeCount:number;businessCount:number;
  unassignedCount:number;todoCount:number;inProgressCount:number;inReviewCount:number;
  changesRequestedCount:number;completedCount:number;failedCount:number;cancelledCount:number;
  overdueCount:number};
```

No accessible membership returns valid empty items and zero counts. Use `viewerRelation` and `assignedToMeCount`; do not label all visible cards "assigned to you". Overdue is a past deadline on an open task (including unassigned); failed/completed/cancelled are not overdue states. Business identity is included on every card.

## Private Cloudinary image flow

Backend environment: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, and `TASK_PUBLIC_API_URL` (HTTPS API origin in production). Never expose API secret in frontend env. Without configuration, image issuance/finalization returns 503; notes/links/task/contact flows work independently.

1. POST `/api/businesses/:businessId/tasks/:taskId/images/upload-intents` with `{name,contentType,sizeBytes}`. Returns `{imageId,uploadUrl,method:'POST',headers:{},expiresAt,fields:{timestamp,public_id,type:'authenticated',overwrite:false,api_key,signature}}`. Intent lasts one hour. Only task participants/managers may issue intents; read-only task:view alone cannot upload.
2. Build `FormData` containing every returned field (convert to strings), then `file`. Upload directly to `uploadUrl`; **omit backend cookies**. Do not change public_id/type/overwrite. Do not use unsigned/public product uploads.
3. POST `/api/businesses/:businessId/tasks/:taskId/images/:imageId/finalize`. Backend queries Cloudinary's authenticated admin API to verify actual resource bytes, format, dimensions, resource type, identity and intent. Returns `{image:Image}`.
4. Submit/comment using finalized `imageIds`, not arbitrary URLs. Attachment and immutable evidence are committed together. Preserve draft image IDs on retryable submission errors.
5. Render authorized read URLs with cookies. An ordinary browser `<img>` can use the API URL when cookie policy permits; a frontend server image optimizer will not automatically have the user's cookies. Alternatively fetch with `credentials:'include'` and use a local blob URL. Refresh via authorized task/attempt/comment reads after expiry. Backend serves bytes from authenticated Cloudinary; it does not expose the reusable provider URL.
6. DELETE `/api/businesses/:businessId/tasks/:taskId/images/:imageId` only deletes the uploader's unattached draft. Returns `{deleted:true}` after marking for provider cleanup. Attached evidence cannot be deleted.

JPEG/PNG/WebP only; max 5 MB; each dimension 1–8000 pixels; max 32 million decoded pixels. Finalized bytes/type must match the intent. Cleanup runs every minute: expired pending uploads, finalized unattached drafts older than seven days, and deletion retries. Submitted images, attempts and history are retained indefinitely by this initial implementation; no automatic submitted-evidence deletion or public deletion API. A later explicit business retention/deletion workflow is required to change that policy. External Cloudinary account deletion is outside the application's guarantees.

## Analytics

GET `/api/businesses/:businessId/task-analytics?from=<ISO>&to=<ISO>&groupBy=employee|member&scope=business|me&limit=30&cursor=...&employeeId=...&memberId=...`.

Default last 30 days, `[from,to)` UTC. scope business requires task:report; scope me uses the current member and rejects a different explicit member ID. Employee grouping excludes member-only assignments, but retains archived employee snapshots. Rows are identities with recorded assignment history; an identity with no task assignments does not get a fabricated zero row. Old identities may have zero measures within the selected period. Pagination is over identity IDs; totals cover all matching identities. Default time bounds/asOf are pinned in the cursor. There is no payroll data.

Measures: assignmentCount, startedCount, submittedAttemptCount, acceptedAttemptCount, failedAttemptCount, changesRequestedAttemptCount, reassignedAwayCount, reassignedInCount, redoAttemptCount, reopenedTaskCount, cancelledAssignmentCount, excludedCancelledCount, openCount, overdueCount, completedTaskCount, onTimeCompletedTaskCount.

- Cohort starts at **assignment.assignedAt**, including creation, reassignment and reopen cycles. Completion numerator is accepted assignments in that cohort; denominator is non-cancelled assignments. Open/reassigned-away assignments stay in denominator. Completion by another person does not credit the previous assignee. Task completion counts deduplicate task IDs, even if multiple cycles complete.
- startedCount counts assignment cycles whose first explicit work-start occurs in the period. Submission/redo counters use submittedAt; acceptance/failure/changes counters use reviewedAt; reassignment-away uses endedAt; reassignment-in/reopen use their history event timestamp.
- First-pass acceptance: accepted first attempts / first attempts submitted in period with a final accepted/failed/changes review as of response. Superseded attempts are excluded.
- On-time completion: accepted cohort assignments accepted by their deadline / accepted cohort assignments with a deadline. Deadline snapshot is captured at acceptance; edits are recorded in task history.
- **Duration definition clarification:** assignment assignedAt to acceptedAt, rather than the optional explicit work-start timestamp. This measures elapsed assignment duration, not hours worked. startedAt is separate. Do not label this metric working time.
- completionRate/firstPassAcceptanceRate/onTimeCompletionRate are `{numerator,denominator,value}`; value is a fraction 0–1, null for zero denominator. averageCompletionSeconds is `{totalSeconds,sampleCount,value}`; null for no samples.
- The response includes `{period:{from,to,asOf,bounds},definitions,totals,items:[{id,identity,...measures}],nextCursor}`. Charts must use the supplied definitions. These are descriptive workload measures, not employment scores.

## Notifications and audit

Creation/assignment, reassignment, submission, review, reopen, cancel and comments are recorded with immutable task history and business audits in the same transaction. Audit metadata contains IDs/status/actor snapshots, not evidence bodies, private URLs or tokens. Access through existing business audit endpoint requires audit_logs:view.

Notifications use the existing inbox APIs and generic nullable-invite contract. Types: task_assigned, task_reassigned, task_submission_received, task_changes_requested, task_completed, task_failed, task_reopened, task_cancelled, task_due_soon, task_overdue. Assignees receive assignment/outcome events; designated reviewers receive pending submissions; creators receive completion/failure outcomes. The actor is not notified of their own mutation. Due-soon means within 24 hours; scheduled reconciler runs every minute. Scheduled notices deduplicate by type/task/assignment/deadline, recheck active eligible recipient/business, and are stored in PostgreSQL. A downtime recovery can create a real overdue notification for an existing open task; it never creates fictional history/tasks. Notification action URL is `/business/:businessId/tasks/:taskId` and opening it must pass current task authorization.

## Errors

400 validation/eligibility/cursor; 401 authentication; 403 capability; 404 unavailable scoped resource; 409 stale revision/transition/review/idempotency; 413 image too large; 415 image type; 503 unavailable persistence/provider. Native DTO validation errors expose message arrays; task errors also include a stable `code`. Key codes: INVALID_CURSOR, MISSING_TASK_CAPABILITY (missingPermissions), INELIGIBLE_ASSIGNEE, INELIGIBLE_EMPLOYEE, REVIEWER_REQUIRED, INELIGIBLE_REVIEWER, EVIDENCE_REQUIRED, REVISION_MISMATCH, INVALID_TASK_TRANSITION, DUPLICATE_ASSIGNMENT, STALE_REVIEW, REVIEW_PENDING, IDEMPOTENCY_CONFLICT, TASK_CONCURRENT_CHANGE, TASK_STORAGE_UNAVAILABLE, TASK_IMAGE_STORAGE_UNAVAILABLE. Safe state conflicts include `{revision,status}`. Task transactions are bounded at 90 seconds to accommodate remote persistence; a rollback retains draft files and retry keys can be retried safely.

## Public contact/demo

POST `/api/public/contact-requests`, no authentication:

```json
{"kind":"demo","name":"Ada Example","email":"ada@example.test","businessName":"Example Store","locations":"2 stores, 1 warehouse","planInterest":"unsure","focus":"Inventory logs","message":"We want to review stock receiving.","website":""}
```

kind contact|demo; name/email/businessName required. Trimmed names max 200, normalized email max 254, locations max 300, message max 2000. Optional planInterest: starter|growth|standard|efficient|unsure. Optional focus: Payroll approvals|Inventory logs|Payment security|Batch and expiry tracking. Values match the currently inspected frontend src/lib/site.ts. website is a honeypot; leave empty. No arbitrary recipient/template/subject fields and no public list/detail APIs.

202 `{requestId,status:'received'}` only after durable PostgreSQL commit. No confirmation email, subscription creation or newsletter enrollment. Replace the frontend's validation-only success with this response and say "request received", not "email sent". Preserve locations/plan/focus fields.

Shared PostgreSQL fixed-window limits: 5 distinct requests/IP/15 minutes, 20/IP/UTC day, 3/normalized email/hour. 429 includes Retry-After seconds to the bucket boundary. IP/email bucket identifiers are HMAC hashes, not raw personal data. Expired buckets are cleaned after a one-day grace period. Honeypot submissions consume rate limits and return a generic 400 rejection; they never return fake received IDs.

Optional Idempotency-Key (1–100 printable non-whitespace ASCII) scoped to normalized email, retained for replay lookup 24 hours. Changed body/key returns 409 IDEMPOTENCY_CONFLICT. Without a key, exact normalized duplicate bodies within five minutes replay the original ID. Successful duplicate replays do not consume another rate slot. Persistence outage returns 503 CONTACT_STORAGE_UNAVAILABLE; never fake success. Contact records remain stored until an explicit authorized retention process removes them; no automatic marketing usage.

## Migration and checks

Additive migration: `20261012120000_tasks_contact`. Adds task/assignment/attempt/entry/image/idempotency/contact/rate-bucket tables, safe tenant FKs, protected permission grants and immutable evidence/history checks. Run `npx prisma generate` and `npx prisma migrate deploy` during deployment. Run `npm test -- --runInBand`, `npm run build`, `npm run lint`, and `npm run db:test:tasks` (isolated test schema, fake provider, no live uploads/emails).

## Copyable frontend implementation prompt

Implement the backend migration described in docs/TASKS_DASHBOARD_CONTACT_FRONTEND_HANDOFF.md. First search all existing task forms, boards, employee/member analytics, dashboard fabricated assigned tasks/counts, notification handlers, public contact/demo actions and related navigation. Replace those existing flows rather than adding disconnected alternatives. Use the existing API client prefix/cookie/auth-refresh conventions; public contact must bypass auth refresh. Preserve current project styling and reusable components.

Use effective task permissions and server capability flags; display creator/assignee/manager relations accurately. Implement unassigned creation, eligible assignee picker, explicit reviewer selection, revision conflicts, stable idempotency keys per draft submission, start, notes/links/private-image evidence, review, changes requested, failure, reassignment, reopen, cancel, comments and paginated immutable history. Add revision to comment bodies. Preserve drafts and finalized image IDs after recoverable errors. Do not PATCH completed or let users approve their own work. Build `/business/:businessId/tasks/:taskId` to receive notification links and preserve callback paths through authentication.

Use Cloudinary authenticated multipart upload intents/finalization and cookie-authenticated short-lived backend reads, never arbitrary public image URLs. Implement uploader draft deletion and expiry refresh. Show a clear storage-unavailable state while credentials are unconfigured; notes and links still work.

Use dashboard authorized summary counts, not loaded-card counts; show cross-business identity and an honest empty state. Implement analytics using the documented assignment cohort and event counters, fractional/null rates and elapsed-assignment duration labels. Never infer salaries, performance scores or inaccessible business data.

Wire public contact/demo to durable 202 responses, retain locations/plan/focus, handle validation/429 Retry-After/503, and keep website empty. Do not promise emails, connect newsletter to this storage or treat plan interest as a subscription. Update generic notification rendering for task types and preserve nullable invite handling. Exercise the main workflows, authorization, concurrent changes, image retries and contact errors before claiming frontend integration complete.
