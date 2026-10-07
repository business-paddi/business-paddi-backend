# Onboarding handoff

Updated: 2026-10-07

## Status

The backend onboarding flow is implemented. `AppModule` imports `OnboardingModule`, which registers `OnboardingController` and `OnboardingService`. The missing `LocationModule` import was added to `OnboardingModule` so Nest can resolve the controller's location dependency. Authentication, database, and audit providers come from their global modules.

Migration `20261007000000_add_onboarding` was generated, reviewed, and successfully applied using `prisma migrate deploy` to the database configured by `DATABASE_URL` in `prisma.config.ts`. It adds `OnboardingDraft`, `Business`, `StaffInvite`, `StaffInviteStatus`, indexes, and foreign keys. It contains no drops or data resets. Both migrations are applied, and a live database-to-schema diff reports no differences. Prisma Client was regenerated.

## API contract

Default development backend: `http://localhost:3001`. All routes below include the global `/api` prefix.

| Method | Route | Behavior | Success status |
| --- | --- | --- | --- |
| GET | `/api/account/onboarding` | Returns `{ business, staff }`, or `null` when no draft exists. Sends `Cache-Control: no-store`. | 200 |
| PATCH | `/api/account/onboarding` | Saves and returns the merged draft. | 200 |
| POST | `/api/account/onboarding/complete` | Completes the saved draft and returns `{ message, business, invites }`. No request body is needed. | 201 |

All three routes use `AccessTokenGuard` and obtain the user ID from the authenticated request. The guard requires an `accessToken` cookie, a valid non-revoked session, a verified email, and an active user. Browser requests must include credentials; CORS permits the configured `FRONTEND_URL`. For PATCH and POST, an Origin header, when present, must match that frontend origin.

Example PATCH body:

```json
{
  "business": {
    "name": "Acme Retail",
    "industry": "Retail",
    "address": "12 Market Road"
  },
  "staff": [
    {
      "name": "Ada",
      "email": "ada@example.com",
      "role": "staff"
    }
  ]
}
```

PATCH requires at least one section. Business fields merge with the saved business; a supplied staff array replaces the entire saved list, and `[]` clears it. Names and roles are trimmed; staff emails are trimmed and lowercased. Duplicate staff emails are rejected. The limit is 50 staff members, with field limits enforced by the DTO. Unknown fields are rejected by the global validation pipe.

Completion requires a saved business name. A transaction creates the business and pending staff invite records, deletes the draft, and records the completion audit event. Draft saves also generate an audit event. Current-user and relevant authentication responses include the saved onboarding draft for resuming the flow.

## Files

- `src/onboarding/onboarding.controller.ts`: authenticated route handlers.
- `src/onboarding/onboarding.module.ts`: controller registration, service registration, and location module import.
- `src/onboarding/onboarding.service.ts`: draft persistence and transactional completion.
- `src/onboarding/dto/upsert-onboarding.dto.ts`: validation, normalization, and response shapes.
- `src/onboarding/onboarding.service.spec.ts`: seven service tests.
- `prisma/schema/onboarding.prisma`: onboarding persistence models.
- `prisma/schema/user.prisma`: user relations to drafts and businesses.
- `prisma/migrations/20261007000000_add_onboarding/migration.sql`: applied migration.
- `src/app.module.ts`, `src/auth/auth.service.ts`, `src/users/users.service.ts`, and `src/audit/audit-event.types.ts`: app registration, resume data, and audit events.

## Verification

- `npx.cmd prisma migrate deploy`: migration applied successfully.
- `npx.cmd prisma migrate status`: database up to date; two migrations present.
- `npx.cmd prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code`: no differences, exit 0.
- `npx.cmd prisma generate`: client regenerated successfully.
- `npm.cmd test -- --runInBand onboarding`: all seven service tests passed.
- `.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.build.json`: application TypeScript compilation passed after client regeneration.
- `git diff --check`: passed; only line-ending conversion warnings were reported.
- Full-project TypeScript compilation previously failed in the unrelated `src/app.controller.spec.ts`, which references the removed `getHello` method.

Use `npm.cmd` and `npx.cmd` in this PowerShell environment because the PowerShell execution policy blocks the npm `.ps1` wrapper. Database commands required approved access outside the network sandbox.

## Remaining work and limitations

- Authenticated HTTP requests and full application startup have not been tested in this handoff. Startup requires the configured environment, Redis, and a readable MaxMind database (`MAXMIND_DB_PATH`).
- Staff invites are persisted as pending records; this flow does not send invitation emails or implement acceptance.
- No persisted onboarding-completed flag or business read endpoint is provided by this flow. A `null` draft can mean either no draft was started or a draft was completed. The frontend should retain/use the completion response and needs a durable completion lookup for future sessions.
- Completion is not protected against concurrent duplicate submissions. Disable repeat submissions in the frontend; backend idempotency remains a follow-up.
- `@IsOptional()` permits explicit JSON null values. In particular, `staff: null` can reach code that expects an array and fail. Harden null validation before exposing this flow broadly.
- Existing work remains uncommitted. No commits or application deployment were performed.
