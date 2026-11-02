# business-paddi-backend

NestJS (v11) API backend: email/password + Google authentication, session
management with refresh-token rotation, account settings, and audit logging
backed by PostgreSQL (Prisma) and Redis.

## Stack

- NestJS + TypeScript, Passport-free JWT (`HS256`) in `httpOnly` cookies
- PostgreSQL via Prisma (`prisma/schema/`, Neon-compatible) + Redis
- Argon2id password hashing, HMAC-peppered OTP codes, Resend emails,
  MaxMind GeoLite2 location lookup

## Prerequisites

- Node.js 22+, a PostgreSQL database, Redis, a Resend API key,
  Google OAuth client credentials, MaxMind account for the GeoIP database.

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in secrets (never commit this file)
npx prisma generate
npx prisma migrate deploy    # needs DATABASE_URL
npm run maxmind:download     # needs MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY
npm run start:dev
```

The API listens on `PORT` (default `3001`) under the `/api` prefix;
`GET /` and `GET /health` are the only unprefixed routes.

## Scripts

- `npm run build` / `start` / `start:dev` / `start:prod`
- `npm run lint`, `npm run test`, `npm run test:e2e`
- `npm run maxmind:download` — fetch the GeoLite2-City database into `data/`
  (git-ignored). The app refuses to boot without it.

## Environment

See `.env.example` for the full list. Auth-critical keys: `DATABASE_URL`,
`REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRES`
(`15m`), `JWT_REFRESH_EXPIRES` (`1d`), `VERIFICATION_CODE_PEPPER`,
`RESEND_KEY`, `RESEND_FROM_EMAIL`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URL`, `FRONTEND_URL`.

## Layout

- `src/identity/` — authentication, sessions, guards, tokens and verification flows.
- `src/business/` — business API and subfolders for employees, groups, invitations, members, notifications, audit and access checks.
- `src/inventory/` — catalog, stock, checkout and reporting services behind a stable InventoryService facade. Shared write safety lives in inventory-context.ts.
- `src/policies/`, `src/payroll/`, `src/tasks/`, `src/referrals/` — product feature modules. Policy AI remains disabled.
- `src/common/`, `src/config/`, `src/database/`, `src/redis/`, `src/email/`, `src/location/`, `src/rate-limit/` — shared infrastructure.
- `prisma/schema/` — domain schemas; `prisma/migrations/` — immutable migration history.
- `scripts/checks/`, `scripts/seeds/`, `scripts/maintenance/`, `scripts/lib/` — executable checks, explicit seeds, maintenance tools and script helpers. Run from the repository root; npm command names are unchanged.
- `docs/README.md` — documentation index and current frontend integration contracts.
- Unit and HTTP contract tests live beside source; `test/` contains end-to-end tests.

Keep new feature files within their domain. Use business subfolders for related responsibilities without creating a Nest module for every folder. Extract a service when it has a coherent responsibility; preserve authorization and transaction boundaries when doing so.

## License

UNLICENSED (private).

## Remita payroll proof of concept

See [local setup and runnable examples](docs/integrations/remita-local.md) and [feasibility/blockers](docs/integrations/remita.md). The integration is disabled by default and supports mock/approved sandbox only, never live transfers or custody.
