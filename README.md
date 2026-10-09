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

- `src/auth`, `src/session`, `src/users`, `src/password-reset`,
  `src/sensitive-action`, `src/login-verification`,
  `src/verification-code`, `src/email-change-verification`,
  `src/google-auth`, `src/audit` — feature modules
- `src/auth-token`, `src/auth-cookie`, `src/auth-guard` — token/cookie/guard
  plumbing; `src/rate-limit`, `src/email`, `src/location`, `src/redis`,
  `src/database`, `src/config`, `src/common` — infrastructure
- `prisma/schema/` — database schema; `prisma/migrations/` — migrations
- `docs/BUSINESS_FRONTEND_HANDOFF.md` — business endpoint contract and frontend integration notes

## License

UNLICENSED (private).
