# Plans and referrals: implemented backend contract

All URLs below include the existing `/api` prefix exactly once. Account endpoints use the existing verified-account cookie guard, CSRF/origin middleware and no-store responses. Response bodies are direct JSON. No established permissions or grants were changed.

## Available endpoints

| Method and route | Request | Response |
| --- | --- | --- |
| GET `/api/plans` | Public; no body | `{currency:"USD",currencyExponent:2,annualDiscountBps:1500,plans:[...]}` |
| GET `/api/account/referrals` | Authenticated; no body | `{code:null|string,firstPaymentRateBps:1000,referredCount,conversions,earnings:[{currency,pendingMinor,availableMinor,paidMinor}]}` |
| POST `/api/account/referrals/code` | Authenticated; no body (or `{}`) | `{code:"stable-public-share-token"}` |
| GET `/api/account/referrals/earnings?cursor=...` | Authenticated; optional signed cursor | `{items:[{id,createdAt,plan,mode,currency,commissionMinor,originalCommissionMinor,reversedMinor,status}],nextCursor:null|string}` |
| POST `/api/account/plan-selection` | `{plan,mode,referralCode?}` | `{selectionId,nextPath:"/dashboard/business"}` |

POST responses are HTTP 200, including idempotent retries. Account actors always come from the authenticated session. Sending actor IDs, price strings, commission values, redirect URLs or other unknown request fields is rejected. Shared-link visits and Efficient contact submissions do not call selection automatically.

Plans: `starter`, `growth`, `standard`, `efficient`. Modes: `monthly`, `annually`; the frontend must normalize `annual` before submitting. Selection rejects Efficient with 400 and directs the person to the contact form. Starter records a trial candidate, not an activated trial. All selections remain pending choices; they never create subscriptions, charge money, assign paid entitlements or alter a subscriber's paid plan.

Catalog minor units: Growth 1877 monthly / 19145 annually; Standard 4130 monthly / 42126 annually. Starter is a 14-day trial with zero price; Efficient is a custom quote with null prices. Annual price uses `(monthlyMinor * 12 * 85) / 100`, rounded half up once with integer arithmetic. Catalog entries include `checkoutAvailable:false` while billing integration is absent.

## Codes, attribution and errors

Code creation is serialized on the existing user's database row. Repeated/concurrent clicks return the same token and do not duplicate the creation audit. Tokens contain 192 random bits, encoded as 32 base64url characters. Lookup uses SHA-256; recoverable tokens use AES-256-GCM authenticated encryption bound to code ID. The encryption key is domain-separated from the existing `VERIFICATION_CODE_PEPPER` using HMAC, following the application's existing vault pattern. Keep that root secret stable/backed up; rotation requires an explicit re-encryption migration, not silently generating replacement codes. No new secret is needed to enable these account endpoints.

The first valid attribution wins. Subsequent selections may change plan/mode but retain the original attribution. A different candidate code returns 409. Repeating the same selection returns its original ID without adding audit noise. Omitting the code preserves existing attribution. Invalid, disabled and self-referral codes return useful 409 messages; invalid syntax returns 400. Invalid attempts are committed to the dedicated audit without recording raw tokens. Disabled codes prevent new attribution and leave historical attributions intact.

Rate limits use the existing Redis-backed authenticated limiter: code requests 20/hour/account; selections 30/minute/account. A rate limit returns 429. Redis/database failures return actionable 503, never simulated zero earnings or successful selection. Authentication remains consistent with the existing guard (401 for missing/revoked/unverified/inactive sessions); transaction-level rechecks may return 403 if an account becomes restricted.

An account with no generated code, attributions or ledger returns actual null/zero counts and an empty earnings array. Summary balances come from durable ledger sums per currency in one repeatable-read transaction. Supported ledger display currencies are USD and NGN, both two-decimal. No FX conversion or cross-currency total is performed.

Earning pages contain at most 25 rows, ordered by `(createdAt DESC,id DESC)`. Cursors are authenticated and bound to account and operation. Do not interpret them or forward a cursor from a different account. The displayed `commissionMinor` is the net remaining reward; the additive original/reversed fields explain partial refunds. Conversions count historically qualifying first paid referrals, including later refunded payments; refunds reverse balances rather than erase conversion history.

## Identity and billing boundary

This phase explicitly uses one account-level `ReferralCustomer` per verified user, shared across that account's billing workspaces. `ReferralBillingIdentity` maps each workspace and provider customer alias to that global customer; provider/customer aliases and workspace IDs are unique and immutable. Earnings additionally have a unique customer constraint. Employment records and business membership invitations do not infer referral identity.

Plan selection has no business ID and therefore records only an own-account pending choice, including before workspace setup. It does not choose a paying workspace or assert membership authority. A future checkout adapter must derive the chosen business from authorized server-side context, lock/check existing active business membership and billing ownership, and verify provider identity before creating a billing alias. No public endpoint accepts billing mappings or customer/referrer IDs.

**Launch gate:** account identity does not prove that two different accounts are different legal customers. New customer records default to `pending_review`; they cannot earn rewards until an authorized billing/history integration verifies eligibility and the cross-account identity policy is approved. Historical first paid purchases are never assumed absent and no existing customer or reward was backfilled. These limits deliberately prevent claiming the unresolved identity policy is production-complete.

## Internal settlement engine and unfinished provider integration

The private settlement engine is implemented for future verified provider adapters and is disabled by default. There is no checkout, public webhook endpoint, signature verifier, billing-provider connection, payout endpoint or administrative UI in this phase. `REFERRAL_SETTLEMENT_APPROVED` is intentionally unset/false. No real payment or payout has been initiated. Enabling the flag alone cannot expose a webhook or receive payments.

The supplied handoff labels subtotal/refund calculation and payout policy as proposed, requiring product approval before real payouts. The internal engine implements those proposed calculations under that gate for testing. Hold periods, availability release, thresholds, payout methods, approval authority and paid-out refund adjustments remain undecided. No automatic availability/withdrawal process exists; rewards stay pending.

When a provider is chosen, its adapter must first verify signatures/timestamp/replay protections, fetch authoritative settled subscription subtotal after discounts excluding taxes/fees, confirm the first positive successful payment against provider history, verify the paying business/customer mapping, and pass only minimal verified metadata to `processVerifiedEvent`. The engine is not exported by the module and has no HTTP request DTO. Unverified client redirects and invoice strings cannot invoke it.

Provider price IDs stay server-side: `BILLING_GROWTH_MONTHLY_PRICE_ID`, `BILLING_GROWTH_ANNUALLY_PRICE_ID`, `BILLING_STANDARD_MONTHLY_PRICE_ID`, `BILLING_STANDARD_ANNUALLY_PRICE_ID`. They are not configured or invented by this implementation. Signed adapter events must match a configured price; client prices never authorize payment. The initial internal settlement path accepts USD only; NGN checkout/conversion is a separate provider decision.

Verified events use a unique `(provider,eventId)`, payload digest and transaction-level payment lock. Reused IDs with changed content are rejected. Provider payment ID, earning payment ID and earning customer uniqueness enforce first-payment-only rewards across retries, renewals and workspace aliases. A provider-confirmed prior purchase disqualifies later referral payments. First payment, earning, ledger credit and audit writes commit atomically.

Refunds use verified cumulative refunded subscription subtotal and cumulative proportional rounding, bounded by the original commission. Duplicate/stale events cannot over-reverse. Refund-before-payment is held durably and replayed when payment arrives. Out-of-order renewals need verified first-payment history and cannot be mistaken for the qualifying first payment. Refunds against already-paid rewards are quarantined for the undefined settlement policy; they are not silently charged back to users.

## Dedicated audit and database invariants

Migration `20261020190000_plans_referrals` adds code/customer/billing-alias/selection/attribution/payment/earning/ledger/webhook/audit storage and SQL constraints. It contains no historical rewards or paid entitlement backfill.

`ReferralAudit` and `ReferralLedgerEntry` are append-only SQL tables. Metadata keys are allowlisted and contain no raw referral tokens, secrets or personal details. Audits include code creation/disablement, accepted/rejected attribution, changed plan selection, qualification/nonqualification, reward credit/reversal, and future availability/payout state transitions. Audit and financial writes are atomic. Ledger inserts must reconcile to the earning and cannot create negative balances.

`ReferralAuditService.queryForAccount(authorizedUserId,{cursor,from,to,event})` is prepared for a future session-derived own-audit endpoint. It uses bounded keyset pagination, UTC ISO date filters and operation/account/filter-bound cursors; returned records omit other-party IDs. There is no public audit endpoint or global-admin query. A business owner/admin or `audit_logs:view` grant never confers platform-wide referral audit access. A future admin endpoint needs separate platform-admin authorization.

## Verification

Unit coverage includes exact prices, integer rounding, token encryption/authentication, DTO rejection of spoofed fields, cursor isolation, readonly summaries, verified accounts and disabled settlement. `scripts/test-referrals.ts` exercises the real migration, concurrent code generation/selection, immutable attribution, first-payment/renewal/alias/refund replay invariants, audit isolation, append-only storage, atomic rollback and stable earning pagination in a uniquely named disposable SQL schema. It clones schema definitions only, never live rows, then removes that isolated schema. Live accounts, grants and balances remain untouched.

Run live schema deployment with the normal Prisma migration process after checks. The frontend can connect to the account endpoints immediately after deployment; checkout/webhook/payout integration remains a separate, explicitly gated phase. Existing signup/email verification/Google OAuth return URL handling was not modified.

## Delivery verification

Migration applied and database up to date. Lint and TypeScript passed; all 330 tests passed. All 20 isolated database checks passed and the disposable schema was removed. Live server checks: health 200, public plan catalog 200 with exact annual prices, and private referral summary/earnings 401 without authentication with no-store headers. Checkout, signature-verifying webhooks and payouts remain unconnected and disabled as described above.
