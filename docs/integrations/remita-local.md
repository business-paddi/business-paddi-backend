# Remita payroll local setup and API handoff

This is an instruction-only, non-production proof of concept. No wallet, internal balance, custody account, salary-transfer endpoint or live mode exists. A mock RRR cannot be paid. A paid invoice is not proof that employees received salaries.

## Setup

1. Use the repository's normal PostgreSQL, Redis, login and application environment setup. Apply migrations with `npx prisma migrate deploy`, generate the client with `npx prisma generate`, and start with `npm run start:dev`.
2. Set `PAYROLL_PROVIDER=remita`, `REMITA_MODE=mock` and `NODE_ENV=development`. Generate and retain a canonical base64 32-byte `PAYROLL_ENCRYPTION_KEY` (the existing payroll encryption mechanism). Do not replace a key protecting existing records. Mock mode requires no Remita credentials and rejects them if present. It makes no internet request. PostgreSQL and Redis may both run locally.
3. Leave `PAYROLL_PLATFORM_FEE_KOBO=10000` for the sample: this is a configurable gross NGN 100.00 vendor allocation, not an agreed commercial price. The mock vendor uses synthetic `058:0000000001` and is explicitly labelled MOCK. Never reuse it for real money. Provider fee remains null/unknown.
4. Use synthetic employee accounts `0000000002`, `0000000003`, etc., in mock mode. The mock gate rejects other account patterns. Existing employee verification is NOT bypassed or modified: the existing payroll preparation flow still requires ready, verified banking snapshots and independent payroll approval. Use the isolated integration test below for a complete flow without fabricating verified employees in your application database.
5. `REMITA_RECONCILER_ENABLED=true` enables the minute-based durable reconciliation poller. Set false when driving every test using refresh-status. The provider is disabled by default when PAYROLL_PROVIDER is unset/disabled. Enabling it in NODE_ENV=production or selecting live mode fails startup.

### Automated local proof

```sh
npm run test:remita
npm run db:test:remita
```

The unit/provider suite needs no credentials, internet, Redis or database. It uses an in-process deterministic mock and a loopback HTTP stand-in for the sandbox wire contract, including JSONP, timeout and 503 responses. Postman CLI is not installed in the inspected environment; no hosted workspace or public webhook is required. These local wire tests do not establish Remita sandbox entitlement.

The database/HTTP integration script needs PostgreSQL access through the normal DATABASE_URL (or DIRECT_URL). It creates a uniquely named `remita_test_*` schema, clones only existing payroll/audit table definitions, applies the new migration there, and uses exclusively synthetic users, recipients and encrypted fake bank details. It never copies employee rows. Its HTTP test application uses test-only principals plus the real service permission checks, not real session cookies. It drops the disposable schema afterward. Do not expose that test harness publicly. The public application's AccessTokenGuard remains unchanged.

The integration script verifies preparation, integer totals, fee allocation, idempotency, independent approval, tenant/permission denial, database-enforced snapshot immutability, concurrent invoice claims, timeout recovery without repeat creation, collection versus settlement, underpayment, partial settlement, reversals, unknown failures, mock-event replay, unsigned-webhook signalling and HTTP validation. Existing payroll draft/submit/review tests remain the authority for their unchanged workflows.

## Existing payroll and new payment routes

Prefix: `/api/businesses/:businessId/payroll`. All business routes require the existing `accessToken` session cookie, an active verified user, approved business membership and `payments:view`. Responses use BusinessPaddi's existing unwrapped payload; Axios raw responses expose it at `response.data`. Financial route responses use `Cache-Control: no-store`.

Continue creating drafts, adding employee recipients, calculating, submitting and independently reviewing through the existing `/batches` APIs documented in [payroll preparation handoff](../handoffs/PAYROLL_PREPARATION_FRONTEND_HANDOFF.md). An instruction can only be prepared for an APPROVED NGN batch; it cannot change that batch, its compensation or employee banking/verification status.

| Method / suffix                            | Additional permission | Body / behaviour                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/batches/:batchId/payment`           | payments:create       | `{ "payerName":"Synthetic Employer", "payerEmail":"payroll@example.test", "payerPhone":"08000000000" }`; require `Idempotency-Key` (1–100 letters/digits/underscore/hyphen). Returns the immutable DRAFT instruction and complete salary/vendor breakdown. |
| GET `/payments/:paymentId`                 | invoices:view         | Detail; account ciphertext is withheld, approved account suffixes are available as accountLast4.                                                                                                                                                           |
| POST `/payments/:paymentId/approve`        | payments:approve      | `{}`. Actor must differ from instruction creator and every payroll contributor. Approves the full instruction including fee/payer details.                                                                                                                 |
| POST `/payments/:paymentId/invoice`        | invoices:create       | `{}`. Only an approved instruction may issue one creation call. Repeated calls return that resource; ambiguous outcomes remain INVOICE_UNKNOWN and are reconciled by reference.                                                                            |
| GET `/payments/:paymentId/payment-status`  | invoices:view         | Stored status only; no network side effect.                                                                                                                                                                                                                |
| POST `/payments/:paymentId/refresh-status` | invoices:view         | `{}`. Re-query the provider. Latest check token prevents an older concurrent response overwriting newer evidence.                                                                                                                                          |
| POST `/payments/:paymentId/cancel`         | payments:cancel       | `{}`. Draft/approved instructions cancel locally. Issued invoices must independently verify unpaid before cancellation. Unknown outcomes remain CANCEL_UNKNOWN; they never authorise a replacement.                                                        |
| POST `/payments/:paymentId/mock-event`     | invoices:create       | Mock/non-production only: `{ "eventId":"event-1", "scenario":"PAID" }`. This sets the fake provider state; refresh afterward. Event replay is deduplicated; reusing an event ID with a different scenario returns 409.                                     |

There is at most one noncancelled instruction per payroll batch. A cancelled instruction can be replaced with a fresh instruction and independent approval for that same unchanged approved salary batch. Changing approved salaries requires an explicit approved-payroll revision workflow, not editing this snapshot; see the documented blocker in [research](remita.md).

Mutation limits per authenticated user per minute: prepare/approve 20; invoice/refresh/cancel 10; mock-event 30. Detail/status reads: 60. These reuse the existing Redis-backed authenticated limiter. Existing payroll routes/permissions/grants are unchanged.

### Response interpretation

Money is an integer-kobo decimal string, never a floating-point number. Top-level fields include id, businessId, batchId, provider, simulation, state, merchantReference, remitaRRR, providerStatus, settlementStatus, period, currency, totalNetSalaryKobo, platformFeeKobo, providerFeeKobo (null when unknown), totalInvoiceKobo, payer, beneficiaries, createdBy, approvedBy, approvedAt, verifiedAt, lastCheckedAt, lastErrorCode, paymentUrl and notice.

Each beneficiary has lineItemId, employeeId (null for the vendor), recipientType (EMPLOYEE/PLATFORM_FEE), name, bankCode, amountKobo, accountLast4, account (`[encrypted; withheld]`) and status. Use existing authorised employee banking screens to investigate account details; never display ciphertext. No account number is returned by this integration.

`state` tracks instruction execution (DRAFT, APPROVED, CREATING, INVOICE_UNKNOWN, INVOICE_READY, CANCEL_REQUESTED, CANCEL_UNKNOWN, CANCELLED). `providerStatus` tracks collection (UNKNOWN, UNPAID, PAID, FAILED, MISMATCH, REVERSED). `settlementStatus` is separate. In sandbox, recipient/settlement status stays UNKNOWN because no confirmed settlement contract is implemented. In mock mode PARTIAL/SETTLED/REVERSED are explicitly synthetic evidence; simulation=true and notice always identify them as such.

An invoice request can return HTTP 200 with INVOICE_UNKNOWN. Inspect state and lastErrorCode; do not interpret 200 as successful collection. A failed status lookup retains last verified historical information and sets PROVIDER_STATUS_UNAVAILABLE; show verifiedAt/lastCheckedAt with any stale result. Underpayment or mismatched references clear current verification and return MISMATCH/UNKNOWN, not paid salary. No browser return URL can alter collection status.

`paymentUrl` is null in both modes. In approved sandbox testing, show the RRR and direct the officer to Remita-provided payment instructions; the code invents no checkout URL. Do not show fake mock references as payable.

### Error examples

Provider disabled: HTTP 503 `{ "code":"PAYROLL_PROVIDER_DISABLED", "message":"PAYROLL_PROVIDER_DISABLED", "statusCode":503 }`.

Independent approval: HTTP 403 `{ "code":"INDEPENDENT_REVIEWER_REQUIRED", "message":"INDEPENDENT_REVIEWER_REQUIRED", "statusCode":403 }`.

Unknown or spoofed body fields: HTTP 400 with the existing payroll filter, e.g. `{ "code":"PAYROLL_REQUEST_ERROR", "message":["property amountKobo should not exist"], "error":"Bad Request", "statusCode":400 }`.

Other consequential codes include IDEMPOTENCY_KEY_REQUIRED (400), IDEMPOTENCY_CONFLICT / PAYROLL_INSTRUCTION_EXISTS / INVALID_PAYMENT_TRANSITION (409), APPROVED_NGN_PAYROLL_REQUIRED (409), MOCK_REQUIRES_SYNTHETIC_BENEFICIARIES / UNAPPROVED_SANDBOX_BENEFICIARY (422), REMITA_SPLIT_ONBOARDING_BLOCKED (409), PAYROLL_PROVIDER_MODE_MISMATCH (409), and existing 401/403/404/429/503 responses. No upstream response body, secret, signature or bank account is returned in an error.

## Mock scenarios

UNPAID, PAID, FAILED, PARTIAL, SETTLED, REVERSED, UNDERPAID, TIMEOUT, ERROR. Set TIMEOUT before invoice creation to test ambiguous generation; changing to UNPAID and refreshing reconciles the original fake order without another create. PAID confirms only collection; SETTLED separately supplies synthetic recipient evidence. PARTIAL marks one salary line paid and leaves all others UNKNOWN. REVERSED supplies synthetic reversal evidence. Mock events never hit a provider or move money.

## Sandbox gate

Use only issued sandbox credentials and explicitly approved fake beneficiary fixtures. Required settings are in `.env.example`; `REMITA_BASE_URL` must exactly equal the documented `https://demo.remita.net/remita/exapp/api/v1/send/api/echannelsvc`, `REMITA_CREDENTIAL_ENV=sandbox`, and REMITA_MODE=sandbox. The platform beneficiary is also required to be on REMITA_SANDBOX_FIXTURE_ACCOUNTS (`bankCode:accountNumber` comma-separated). Invoice generation additionally requires `REMITA_SANDBOX_SPLIT_APPROVED=true` after provider confirmation. No live fallback, redirect following or automatic invoice retry exists.

The app cannot cryptographically identify the environment a secret belongs to. The operator must verify provenance with Remita; setting a flag does not replace onboarding. No official sandbox call was made as part of this implementation because no issued/approved sandbox fixtures or entitlement were supplied. Do not place real employee accounts into the fixture list.

## Webhooks

POST `/api/integrations/remita/webhook` accepts the documented notification array only in sandbox mode. It has no browser session requirement; notification bodies are untrusted. Only known matching RRR/order references enqueue a status lookup. Unknown references receive the same plain-text `Ok` without revealing existence. Repeat fingerprints within 60 seconds are no-ops. Payloads are not persisted; only a hash/timestamp and reconciliation request are stored. Per-IP existing limiter: 30/minute. The minute worker or authorised refresh independently checks Remita. Malformed arrays return 400; missing sandbox mode returns 404; rate limits return 429. The route does not implement an invented provider signature scheme.

To test replay without a public receiver, run the isolated integration script. Provider-origin capture would require a registered Remita sandbox notification URL and access to a webhook capture tool; that setup is not claimed complete. No hosted webhook or outbound notification was created.

## Artifacts

- [Feasibility, official sources and blocked production features](remita.md)
- [OpenAPI contract](remita.openapi.json)
- [Runnable REST requests](remita.http) — supply real local session cookies for the maker and independent approver; no secrets are committed.
- `src/payroll/payments/remita.spec.ts` — offline/provider-wire suite.
- `scripts/checks/test-remita-payroll.ts` — isolated PostgreSQL/HTTP proof.

The new migration adds instruction and mock-event records/constraints only; it does not backfill actual payments, alter balances or initiate provider calls.

Merchant/service identity is frozen as a binding hash in the approval snapshot. Changing the configured merchant, service type or sandbox host blocks invoice creation for the old instruction; create a fresh instruction and obtain approval instead. API-key rotation for the same merchant is not part of that hash. A callback matching an unresolved order may request order-status reconciliation, but its RRR is never accepted as verified evidence. Accepted signals are audited atomically with their queue request.

Named payment detail, stored status and refresh-status also require payroll:view_details.
