# Business frontend integration handoff

## Setup and deployment

Run `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, and
`npm run db:seed`. The business foundation and business management migrations
are additive to the existing authentication and onboarding migrations.
System-role seeding is idempotent. Five employee types are created per new
business: `full_time`, `part_time`, `contractor`, `intern`, `temporary`.
The CLI seed only seeds system roles; existing businesses lacking employee
types need a separate backfill using `seedEmployeeTypes`.

Configure `PAYROLL_ENCRYPTION_KEY` as a persistent base64-encoded 32-byte secret
before using bank account or tax identifiers. Generate once with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
Keep it only on the backend and preserve it across deployments. Missing keys
produce 503 for sensitive operations; ordinary employee creation still works.

## Requests and authentication

All routes below have the `/api` prefix and use existing cookie authentication.
Send `credentials: 'include'` and the configured frontend Origin on mutations.
Get the signed-in account from `GET /api/account/me`. JSON requests reject
unknown fields. POST normally returns 201; GET, PATCH and PUT return 200.
Handle 400 validation, 401 authentication, 403 permission, 404 hidden/missing
business or record, 409 conflict, 410 expired invitation, and 503 dependency errors.
Business responses use `Cache-Control: no-store`.

## Creation

`POST /api/businesses` accepts `{name, description?, industry?, country?, profileImage?}`.
Country is `NG`; images require HTTPS. Nullable description, industry and image
can be cleared. Creation assigns the authenticated user the owner membership.

`POST /api/businesses/onboard` accepts:

```json
{
  "business": {"name": "Example business", "country": "NG"},
  "employees": [
    {"fullName": "Example employee", "email": "employee@example.com", "state": "Lagos", "employeeTypeKey": "full_time", "connectToPlatform": false}
  ]
}
```

Employees are optional (maximum 100). Creation returns `business`, `membership`,
`employeeTypes`, `employees`, and `invitations`. All database creation is atomic.
Use an `Idempotency-Key` of 16–80 letters, digits, underscores or hyphens for
creation retries. Reusing it with different input produces 409. Replays return
the committed snapshot; fetch invitations again for current delivery status.

Creating a business or employee alone sends no email. `connectToPlatform: true`
records an employee-role invitation and sends email after commit. The HTTP
request waits for delivery attempts; no background worker is implemented.
Failure preserves committed records and reports failed or pending delivery.

## Available routes and required permissions

Paths in this table are relative to `/api/businesses/:businessId`.

| Method | Path | Permission |
|---|---|---|
| GET | `/api/businesses` (absolute) | Active membership |
| GET | business root | Active membership |
| PATCH | business root | `business:update` |
| GET | `/summary` | `employees:view` and `members:view` |
| POST | `/employees` | `employees:create` |
| GET | `/employees` | `employees:view` |
| GET | `/employees/:employeeId` | `employees:view`, or linked own employee with `employees:view_own` |
| PATCH | `/employees/:employeeId` | `employees:update` |
| PATCH | `/employees/:employeeId/archive` | `employees:archive` |
| GET | `/employee-types` | `employee_lists:view` |
| POST | `/employee-types` | `employees:create` |
| GET | `/groups` | `employee_lists:view` |
| POST | `/groups` | `employee_lists:create` |
| GET | `/members` | `members:view` |
| GET | `/roles`, `/roles/:roleId` | `roles:view` |
| GET, POST | `/invites` | `members:invite` |
| POST | `/invites/:inviteId/revoke`, `/invites/:inviteId/resend` | `members:invite` |
| GET, PUT | `/employees/:employeeId/tax-profile` | `employees:view` and `employees:update` |

## Employee forms

Standalone creation requires exactly four identity values: `fullName`, `email`,
`state`, and `employeeTypeId`. Fetch business types first; onboarding instead
uses one of the default `employeeTypeKey` values. Email is normalized to lowercase.
State must match a Nigerian state name or `FCT` exactly.

Optional fields: `jobTitle`, `managerEmployeeId`, `groupIds`, `bankCode`,
`bankName`, `accountNumber`, `accountName`, `amount`, `payFrequency`, `currency`,
and `status`. Manager/type/groups must belong to this business. Set manager and
group IDs after new-business onboarding because those records do not yet exist.
`groupIds` replaces the group selection. Compensation is a decimal string
with up to two fractional digits, or null; unknown compensation is not zero.
Account numbers are ten-digit strings. Currency is `NGN`; pay frequencies are
`weekly`, `bi-weekly`, `monthly`, `one_time`; writable statuses are `active`,
`suspended`, `on_leave`. Use the archive route for archival.

Do not send membership links, verification status, or payment eligibility.
Bank changes reset verification. Newly registered employees are blocked for
payment; registration alone does not create a user, membership or tax profile.
Archiving retains history and does not revoke membership access.

Employee listing accepts `page` (default 1), `pageSize` (default 20, maximum 100),
`search`, `status`, `employeeTypeId`, `sortBy` (`fullName`, `email`, `createdAt`),
and `sortOrder` (`asc`, `desc`). Default listing excludes archived employees.
Lists exclude bank/tax data. Bank detail requires `employees:update`.
Employee responses wrap the record in `employee`; collection responses use `items`.

Type creation takes `{name, key, description?}`; keys match
`^[a-z][a-z0-9_]{0,63}$`. Group creation takes `{name, description?}`.

## Roles and invitations

Use the exact catalog and seven role mappings in
`src/business-foundation/permission-catalog.ts`. A membership has one role.
Effective permissions are grants minus denials. System definitions are global
and immutable; custom roles are business-scoped. There are currently no
custom-role editing, member-role editing or ownership-transfer endpoints.
Admin lacks `roles:view` and `roles:assign` under the authoritative mapping.

Invitation creation accepts `{email, employeeId?, roleId?}` and returns
`{invitation}`. Role defaults to system employee. Other roles additionally
require `roles:assign`; owner invitations are forbidden. Optional employee
links require an unarchived, unlinked record with the same email.

Frontend acceptance path is `/business-invites/accept?token=...`.
Submit `{token}` to `POST /api/business-invites/accept` after authenticating
an active user whose verified email matches the invitation. Acceptance creates
membership and optionally links the employee atomically. The inviter must still
have authority. Active membership cannot be replaced; inactive membership can
only be reactivated with the same role and `members:update_status` authority.

Invitation lifecycle: `pending`, `accepted`, `expired`, `revoked`.
Delivery status: `pending`, `sent`, `failed`; sent means provider acceptance.
Tokens expire after seven days. Resend rotates the token without extending
expiry; expired/revoked invites require a new invitation. Raw tokens and token
hashes are never returned by management endpoints. Do not log acceptance tokens.

## Tax and summaries

Tax GET returns `{taxProfile: null}` if no profile exists. PUT creates or updates
the one profile per employee. Supported fields are defined by `TaxProfileDto`
in `src/business/business.dto.ts`; identifiers are encrypted at rest, dates use
`YYYY-MM-DD`, contribution rates are decimal strings from 0 to 100 with up to
four fractional digits. End dates cannot precede start dates. Accountant and
employee system roles cannot access these endpoints.

Summary counts reflect stored records, not statutory compliance. Tax liability
is null and compliance is unavailable. No PAYE calculation, payroll execution,
bank verification, or tax filing endpoint is implemented here.

## Validation and operational limits

Previous implementation checks passed 139 unit/API tests, 39 live business
checks and 49 live SQL integrity checks. Auth end-to-end testing remained
incomplete because of intermittent Neon connection/WebSocket errors, including
a failed fixture cleanup. This cleanup PR reruns local tests, lint, build and
schema validation; its PR description records current results.

## Instructions for the Frontend Integration Agent

Preserve the existing UI and shadcn components. Replace mock/local-storage
business records with these APIs. Keep onboarding identity requirements light;
bank, salary and tax setup are optional. User onboarding preferences remain
separate from business creation and live in user preferences. Respect effective
permissions, nullable values and real delivery states. Do not add ownership
transfer or role-management calls that the backend does not implement.
