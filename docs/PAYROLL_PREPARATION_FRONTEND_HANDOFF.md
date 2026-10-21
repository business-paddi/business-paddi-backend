# Payroll preparation and independent approval

Implemented contract, 14 October 2026. Frontend work should inspect existing money/employee/tax-profile flows and migrate them to this contract. Paths below include `/api`; do not add the prefix twice. Approval records a preparation decision only. No bank verification, funding, transfers, settlement, payment providers, payslips or payment retries are implemented by this feature.

## Requests and permissions

Use existing authenticated cookies, credentials-enabled requests and the configured frontend Origin. Every operation requires an active verified account, active business, active approved/not-required membership and effective grants after explicit denials. No role-name authorization. `payments:view_own` grants no access to these routes.

Base: `/api/businesses/:businessId/payroll`.

| Method | Path | Grants in addition to `payments:view` | Body / query |
|---|---|---|---|
| GET | `/batches` | none | `status?, periodFrom?, periodTo?, cursor?, limit?` |
| POST | `/batches` | `payments:create` | Create below |
| GET | `/batches/:batchId` | none | none |
| GET | `/candidates` | `payments:create` | `q?,employeeTypeId?,groupId?,payFrequency?,periodStart?,periodEnd?,cursor?,limit?` |
| GET | `/batches/:batchId/recipients` | none | `q?,readiness?,cursor?,limit?` |
| PATCH | `/batches/:batchId` | `payments:create` | `{expectedRevision,name?,payDate?,notes?,addEmployeeIds?,removeRecipientIds?}` |
| PATCH | `/batches/:batchId/recipients/:recipientId` | `payments:create` | `{expectedRevision,baseAmount?,baseOverrideReason?,adjustments?,notes?}` |
| POST | `/batches/:batchId/refresh` | `payments:create` | `{expectedRevision,recipientIds}` |
| POST | `/batches/:batchId/submit` | `payments:create` | `{expectedRevision,note?}` |
| POST | `/batches/:batchId/review` | `payments:approve` | `{expectedRevision,decision:"approve"\|"request_changes",note?}` |
| POST | `/batches/:batchId/cancel` | `payments:cancel` | `{expectedRevision,reason}` |

Creation returns 201; other mutations return 200. All responses disable caching. Every POST requires `Idempotency-Key`: 1–100 printable ASCII characters without spaces. Reuse it only for an exact retry, including the same expectedRevision. The original committed JSON response is retained indefinitely. Current authorization is rechecked before a replay. Changed body/route/batch/recipient with the same business/user/key returns 409. Failed transactions do not consume keys. PATCH keys are optional; expectedRevision is always required. An uncertain request must be reconciled with GET or the original key, never automatically retried with a new key.

Dates are real `YYYY-MM-DD` Lagos calendar dates; UTC timestamps are ISO strings. `periodStart <= periodEnd <= payDate`. Period/frequency/currency cannot be patched. Money inputs are strings containing 0–16 integer digits (canonical, no leading zeros except zero) and optionally one/two decimal digits; responses always have two. Maximum input and aggregate amount: `9999999999999999.99`. No floating-point money or signed adjustments. Bank numbers/codes remain strings.

Lists default to 25, max 100. Cursors are signed and scoped to actor/business/route/filters. Batches sort by createdAt descending then ID descending. Period filters select overlapping inclusive pay periods; summary counts cover the same authorized filters before pagination. Candidates/recipients sort by ID ascending. Candidate period dates must be supplied together; otherwise default to the current Lagos month. Candidates include active employees, including incomplete/future-starting records with blockers. Ineligible employees explicitly selected on creation remain visible as blocked recipients; foreign/missing IDs reject the complete request. Membership linkage is optional.

Create:

```json
{"name":"October payroll","periodStart":"2026-10-01","periodEnd":"2026-10-31","payDate":"2026-10-31","payFrequency":"monthly","currency":"NGN","employeeIds":["employee-id"],"notes":"Prepared for review"}
```

At most 250 active recipients per batch, 250 selected IDs per add/remove/refresh request. Arrays must contain unique IDs. Removal soft-removes a recipient; adding that employee again reuses the immutable recipient ID with a fresh snapshot and resets its manual edits. Submitted versions retain the old record. Adding does not refresh other recipients. An empty draft after removal is permitted but cannot submit.

Up to 50 adjustments per recipient; clientId unique within that recipient. Existing clientIds retain server-generated IDs. Supplying an empty array clears custom adjustments. Omitted arrays leave them unchanged. A base override requires a nonblank reason in the same request. Manual edits survive refresh. Source compensation must still be configured; an override cannot hide a missing source amount.

```json
{"expectedRevision":1,"baseAmount":"300000.00","baseOverrideReason":"Agreed recurring monthly base","adjustments":[{"clientId":"transport","kind":"allowance","label":"Recurring transport","amount":"10000.00","reason":"Contractual monthly allowance"}],"notes":"Check setup"}
```

Names: 200 characters; batch/recipient notes, submit/review notes and cancellation reasons: 2000; adjustment label: 100; clientId: 100; adjustment/override reason: 1000. Strings are trimmed where appropriate. Unknown request fields, client actor identities, statutory lines and client totals are rejected. Clear notes with an empty string; PATCH nulls are not accepted.

## Final response types

These are serialized JSON types. Optional request fields above are not implicitly optional in responses.

```ts
type Actor = {userId:string;memberId:string;name:string;avatar:string|null};
type Blocker = {code:string;message:string;employeeId:string|null;recipientId:string|null;field:string|null};
type Totals = {
  baseAmount:string;allowancesAmount:string;grossAmount:string;
  deductionsAmount:string;netAmount:string;
  employerContributionsAmount:string;totalEmployerCost:string;
};
type Batch = {
  id:string;businessId:string;name:string;
  status:'draft'|'submitted'|'changes_requested'|'approved'|'cancelled';
  periodStart:string;periodEnd:string;payDate:string;
  payFrequency:'weekly'|'bi-weekly'|'monthly'|'one_time';currency:'NGN';
  notes:string|null;revision:number;recipientCount:number;readyRecipientCount:number;
  totals:Totals|null;blockers:Blocker[];calculationStatus:'ready'|'blocked';
  sourceChanged:boolean;calculationVersion:string|null;
  createdAt:string;updatedAt:string;submittedAt:string|null;
  approvedAt:string|null;cancelledAt:string|null;
  createdBy:Actor;submittedBy:Actor|null;reviewedBy:Actor|null;
  reviewNote:string|null;cancellationReason:string|null;
  capabilities:{canEdit:boolean;canRefresh:boolean;canSubmit:boolean;
    canApprove:boolean;canRequestChanges:boolean;canCancel:boolean};
};
type Adjustment = {id:string;clientId:string;kind:'allowance'|'deduction';label:string;amount:string;reason:string};
type Recipient = {
  id:string;batchId:string;employeeId:string;
  employee:{fullName:string;jobTitle:string|null;employeeTypeName:string|null;
    employmentStartDate:string|null;businessMemberId:string|null;
    avatar:string|null;status:string};
  bank:{bankCode:string|null;bankName:string|null;maskedAccountNumber:string|null;
    accountName:string|null;verificationStatus:string;verifiedAt:string|null};
  compensation:{amount:string|null;payFrequency:string;currency:string};
  baseAmount:string|null;baseOverrideReason:string|null;adjustments:Adjustment[];
  statutoryLines:{code:string;label:string;kind:'employee_deduction'|'employer_contribution';amount:string;calculationReference:string}[];
  totals:Totals|null;readiness:'ready'|'blocked';blockers:Blocker[];warnings:Blocker[];
  calculationVersion:string|null;sourceVersion:string;snapshottedAt:string;
  sourceChanged:boolean;notes:string|null;
};
type Candidate = {
  employeeId:string;fullName:string;avatar:string|null;businessMemberId:string|null;
  status:string;employmentStartDate:string|null;
  employeeType:{id:string|null;name:string}|null;groups:{id:string;name:string}[];
  compensation:{amount:string|null;payFrequency:string;currency:string};
  bankDetailsConfigured:boolean;accountVerificationStatus:string;
  readiness:'ready'|'blocked';blockers:Blocker[];warnings:Blocker[];
};
```

Batch detail and mutations: `{batch:Batch}`. Recipient PATCH adds `{recipient:Recipient}`. Refresh adds `{changes:{recipientId:string,changedFields:('employee'|'bank'|'compensation'|'tax')[]}[]}`; these flags never contain before/after values. Lists: `{items,nextCursor:string|null}`. Batch list additionally returns `{summary:{draftCount,submittedCount,changesRequestedCount,approvedCount}}`, each a number. Candidate/recipient lists do not include a summary.

Capabilities are current-authority hints, not a substitute for server validation. SOURCE_CHANGED is added to detail blockers; stored financial totals remain the explicit snapshot until refresh. Approved totals remain historical regardless of later employee changes. Per-recipient `sourceChanged` can be true on historical snapshots without changing them. No full bank number, tax ID, pension ID, internal source snapshot or contributor list is returned.

## Nigerian calculation policy and source setup

Implemented version: `ng-2026-monthly-v1`, limited to full calendar months with 2026 periods/pay dates, Nigerian resident employees with sole employment and regular recurring cash remuneration. Supported calculations use exact integer kobo, half-up rounding for contributions and monthly PAYE, and the 2026 annual progressive bands. There is no CRA. Rent relief uses qualifying annual rent, capped as prescribed. Pension uses a declared contractual pensionable base with a basic/housing/transport floor and the PRA employee/employer minimum rates, or explicitly documented non-applicability. Custom allowances are recurring taxable cash; custom deductions are post-tax and do not create relief claims. Employer contributions never reduce employee net pay.

Primary sources checked on 14 October 2026:

- [NIPC-hosted Nigeria Tax Act 2025, section 30 and Fourth Schedule](https://www.nipc.gov.ng/wp-content/uploads/2025/07/Nigeria-Tax-Act-2025.pdf).
- [JRB Personal Income Tax Guidelines 2026, Appendix 1](https://www.jrb.gov.ng/assets/2026-pit-guidelines-TJG3n9-T.pdf).
- [Presidential fiscal reforms committee: effective reliefs and minimum-wage exemption](https://www.fiscalreforms.ng/news/fifty-50-tax-exemptions-and-reliefs-that-will-benefit-the-masses-under-the-new-tax-reform-laws-effective-from-1-january-2026).
- [PenCom Pension Reform Act 2014, sections 4 and 120](https://www.pencom.gov.ng/wp-content/uploads/2018/01/PRA_2014.pdf).

This is a monthly preparation calculation, not an annual filing/actual remittance ledger. Nonperiodic bonuses, varying pay requiring cumulative/YTD reconciliation, contractors/WHT, multiple employers, nonresident cases, BIK, public-sector special schemes, employer-only pension and unsupported exemptions must not be represented using the regular-monthly declaration. NHF-applicable cases currently return `NHF_POLICY_UNSUPPORTED`; no old or unverified amended NHF basis is silently applied. Health contributions are explicit reviewed scheme amounts, not an invented uniform national rate. These limitations are intentional blockers or input-scope restrictions, not placeholder successes.

Use the existing tax-profile PUT (requires existing employees:view + employees:update) to save the usual tax identifiers/residency/employment dates/applicability plus this new validated nested object. Existing payment/bank fields can still be saved atomically in that PUT. The payroll endpoints themselves do not require employees:update.

```json
{
  "taxResidencyStatus":"resident","taxExemptionStatus":"none",
  "taxResidenceState":"Lagos","employmentStartDate":"2026-01-01",
  "nhfApplicable":false,"nhisApplicable":false,
  "payrollInputs":{
    "policy":"ng-2026-monthly-v1","taxYear":2026,
    "employmentCategory":"resident_employee",
    "regularMonthlyCashOnly":true,"soleEmployment":true,"claimsReviewed":true,
    "pensionApplicable":true,
    "pensionableMonthlyAmount":"180000.00",
    "basicMonthlyAmount":"100000.00","housingMonthlyAmount":"50000.00","transportMonthlyAmount":"30000.00",
    "annualRentPaid":"2000000.00","annualMortgageInterest":"0.00","annualLifeInsurancePremium":"0.00",
    "nhisEmployeeMonthlyAmount":"0.00","nhisEmployerMonthlyAmount":"0.00",
    "evidenceReference":"Internal reviewed claim records for 2026",
    "pensionApplicabilityReason":"Documented CPS coverage and contractual emoluments"
  }
}
```

All nested fields are required, including explicit zero amounts and applicability declarations. For a non-applicable pension scheme, set pensionApplicable false, pensionableMonthlyAmount to zero, leave contribution rates null/zero and provide a documented applicability reason (max 500). For applicable pension provide the existing PFA and encrypted pension account setup; null rates use statutory minima, supplied rates cannot be lower. Evidence reference (max 500) is required for positive rent/mortgage/life/health claims. Claims are reviewed source inputs, not uploaded proof verified by the API. Keep underlying evidence; a non-applicability reason is not permission to opt out of a legally applicable scheme. Basic/housing/transport and pensionable sums must fit gross cash earnings.

For a supported ₦300,000 regular monthly gross with no pension/health contributions or relief claims, PAYE is ₦36,500 and net ₦263,500. With a ₦180,000 pension base, standard pension rates and reviewed ₦2,000,000 annual rent, employee pension is ₦14,400, PAYE ₦27,908, net ₦257,692 and employer pension ₦18,000. These are bounded examples under the declared policy, not estimates for other employment arrangements.

## Readiness, lifecycle and errors

Missing compensation is blocked even if an override is entered. Explicit zero is valid with `ZERO_NET_NO_TRANSFER`. Active employment must have a known start date on/before period start and no end before period end. No proration or conversion is silently performed. Suspended/on-leave/archived employees are blocked. Missing bank setup is blocked; failed/stale verification is blocked. Unverified setup emits `BANK_UNVERIFIED` but permits preparation/approval under this preparation-only policy; it does not alter verification or payment eligibility.

Blocker catalog: `EMPLOYEE_INELIGIBLE`, `EMPLOYMENT_START_REQUIRED`, `UNSUPPORTED_PRORATION`, `COMPENSATION_REQUIRED`, `FREQUENCY_MISMATCH`, `CURRENCY_UNSUPPORTED`, `UNSUPPORTED_PAY_PERIOD`, `CALCULATION_POLICY_MISSING`, `BANK_DETAILS_REQUIRED`, `BANK_VERIFICATION_FAILED`, `TAX_PROFILE_REQUIRED`, `TAX_IDENTITY_REQUIRED`, `UNSUPPORTED_TAX_TREATMENT`, `CALCULATION_INPUTS_REQUIRED`, `NHF_POLICY_UNSUPPORTED`, `STATUTORY_APPLICABILITY_REQUIRED`, `INVALID_CONTRIBUTION_BASE`, `PENSION_APPLICABILITY_REQUIRED`, `PENSION_BASE_REQUIRED`, `PENSION_RATE_INVALID`, `PENSION_ACCOUNT_REQUIRED`, `PENSION_APPLICABILITY_CONFLICT`, `HEALTH_APPLICABILITY_CONFLICT`, `DEDUCTION_EVIDENCE_REQUIRED`, `RECIPIENTS_REQUIRED`, `SOURCE_CHANGED`. Snapshot calculation blockers produce null totals and empty statutory lines; an otherwise valid historical total is never silently recalculated because source setup changed.

Lifecycle: draft → submitted → approved, or submitted → changes_requested → submitted. Only draft/changes_requested permit edits/refresh. Submitted, approved and cancelled recipients are locked in SQL. No deletion. Cancel requires reason and is permitted before approval, including submitted batches. Cancellation/request_changes releases active duplicate obligations. Approved cancellation/reversal is excluded.

Creator, every editor/refresher (including metadata-only editors, a deliberately stricter separation rule) and every submitter are permanent contributors and cannot review. A current independent approver must exist before submission. The reviewer needs both payments:view and payments:approve. Decisions/reasons and full encrypted internal submitted versions are retained immutably through resubmission. Source employee/bank/tax fields are compared under transaction locks on submit/approve. Refresh is explicit and preserves manual overrides/adjustments.

Overlapping inclusive business/employee periods conflict against submitted/approved batches, regardless of frequency; PostgreSQL range exclusion protects concurrent submissions. This is also the conservative duplicate rule for any future supported one-time calculation. One-time calculations are currently blocked, so do not show a successful one-time submit flow. Conflicts return conflicting batch IDs. Cancelled/changes-requested obligations are released; approved obligations remain.

Errors are `{code,message,statusCode,details?}`; framework validation may have `message:string[]`. 400 invalid fields, money/overflow/negative net/dates/reasons; 401 unauthenticated; 403 denied/self or prior-contributor review; 404 missing/inaccessible business/batch/recipient/employee; 409 `REVISION_CONFLICT` (`details.currentRevision`), `SOURCE_CHANGED` (`details.blockers`), `DUPLICATE_PAYROLL` (`details.conflictingBatchIds`), `INVALID_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE_RECIPIENT`, `CALCULATION_VERSION_CHANGED`; 422 `PAYROLL_NOT_READY` (`details.blockers`) or `INDEPENDENT_APPROVER_REQUIRED`; 503 unavailable storage/encryption. Concurrent database conflicts can return `PAYROLL_CONCURRENT_CHANGE` 409. No dedicated payroll rate limiter was introduced.

Every mutation commits recipients, totals, revision, immutable history, business audit and stored notifications together. Audits use `business.payroll.created/updated/refreshed/submitted/approved/changes_requested/cancelled`, with identity/revision/field flags only. Submission alerts target eligible independent approvers; decisions/cancellation target the creator if they still have payments:view. Notification text/data contains no salary/account/tax/adjustment values. Use existing notification list/read and audit endpoints. No email is sent by payroll.

## Frontend migration

Additional submission/approval policy blocker: `YTD_RECONCILIATION_REQUIRED` (422 with details.blockers). If an earlier approved period in the same year has different gross or statutory lines, this version refuses to substitute a simple monthly projection for cumulative reconciliation. Approved preparation entries are not treated as actual amounts paid/remitted. Preserve the draft and explain that this case needs a cumulative calculation policy; do not tell the user to evade it by creating another batch or changing the declaration.

Use real batch data in `/business/[businessId]/money`, `/money/batches/new` and `/money/batches/[batchId]`. Keep `/money/approve`, `/money/confirm`, `/money/sent` Coming soon and retain commented prototypes. Never display funded/paid/settled as a result of approval.

Build setup for the explicit payrollInputs declarations using existing employee detail/tax profile routes. Explain unsupported cases and link to source setup, then require explicit refresh. Render server breakdowns and warnings without performing tax arithmetic. Preserve failed forms, reconcile 409 with GET, use the shared toast/dialog patterns and invalidate batch list/detail/recipients, notifications and audit after committed mutations. Never optimistically approve.

## Examples and validation

Empty list: `{"items":[],"nextCursor":null,"summary":{"draftCount":0,"submittedCount":0,"changesRequestedCount":0,"approvedCount":0}}`.

See `PAYROLL_RESPONSE_EXAMPLES.json` for complete fake-data responses for ready draft, blocked draft, recipient, submitted and approved states, generated from the isolated integration run. These are demonstration snapshots only.

Run `npm run db:test:payroll` against a disposable PostgreSQL database. It creates/removes an isolated schema, applies every migration and tests authorization, exact money, unconnected employees, snapshot refresh/immutability, contributor separation, rollback, retry deduplication, notifications, redaction and concurrent duplicate protection. No provider calls or money movement occur. Deployment requires the additive `20261014120000_payroll_preparation` migration (including btree_gist), the existing payroll encryption key and normal auth configuration. Existing payroll records retain encrypted destination/tax inputs; retain the encryption key and policy implementation for historical reproduction.
