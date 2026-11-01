# Employee bank details, salary and tax-profile completion

Backend support is implemented. Update the existing frontend flows described below; inspect and reuse existing forms/components before adding alternatives. The API client already adds `/api`, so avoid duplicating it.

## Frontend implementation prompt

Inspect employee listing, Edit employee, employee detail, tax-profile completion and membership profile detail routes. Add a shared employee payment-details section that contains bank details and salary information. Use it in both Edit employee and tax-profile completion, with consistent validation and formatting.

On the employee detail page, add a prominent **Add employee details** button when bank/salary setup is incomplete; use **Edit employee details** when configured. Gate editing with the server's effective employees:update permission. If an employee detail page does not exist, create `/business/[businessId]/employees/[employeeId]` using the existing membership profile detail page as the visual/layout starting point, then adapt it for the employee API and nullable member association. Preserve the project's borders, typography, tabs and component conventions. Do not display invented payroll, tax calculations, verification or payment-success states.

The button should open the same employee-edit flow or shared dialog used by Edit employee. Display bank account details, salary amount, currency and frequency alongside existing identity/employment details. Do not assume every employee is a connected business member. Employee detail editing must use employeeId, never substitute memberId or userId.

Use employee.fullName/email/jobTitle/state for employee identity; businessMember and its user/avatar are nullable. Copy the membership page's layout, not its data assumptions. Membership roles/permissions require their own authorized member API access and must not become a prerequisite for viewing an unconnected employee. GET employee detail includes groupIds; the tax endpoint's additive employee object is for identity/payment prefilling, not a replacement for the full employee editor's detail query.

During tax-profile completion, let authorized administrators enter/update bank details and salary alongside existing tax inputs, and save them through **one PUT request** to the tax-profile endpoint below. Do not PATCH the employee first and PUT the tax profile afterward: the backend saves the combined request atomically. The ordinary employee-edit flow continues to use PATCH employee and accepts the same payment fields.

Inspect and update every existing flow already calling these endpoints. Account numbers remain strings so leading zeroes survive. Salary amounts and contribution rates are decimal strings. Keep drafts after validation/network failures; show success only after the API commits. Refresh employee lists, detail, member-profile employee panels, business summary and tax-profile query caches after successful saves. Do not write audit events from the frontend: the backend records real changes in the same transaction.

## Endpoints and access

| Endpoint | Purpose | Permission |
|---|---|---|
| GET `/api/businesses/:businessId/employees/:employeeId` | Employee detail, current salary and permitted bank details | employees:view, or employees:view_own for the linked employee; financial fields additionally require employees:update |
| PATCH `/api/businesses/:businessId/employees/:employeeId` | Existing employee editor, including bank/salary | employees:update |
| GET `/api/businesses/:businessId/employees/:employeeId/tax-profile` | Prefill tax form and payment section | employees:view **and** employees:update |
| PUT `/api/businesses/:businessId/employees/:employeeId/tax-profile` | Save tax inputs and optional bank/salary together | employees:view **and** employees:update |
| GET `/api/businesses/:businessId/audit-events` | Existing protected business audit feed | audit_logs:view |

Use existing authenticated cookie client, `credentials: 'include'`, refresh/redirect conventions and approved mutation origin. Every record is scoped to businessId. Foreign/missing employees return 404; missing permission/inactive business/membership returns 403; unverified/expired authentication returns 401. Archived employees cannot be edited. Validation errors are 400.

## Shared employee payment fields

Both PATCH employee and PUT tax-profile accept these **flat, top-level** optional fields:

```ts
type EmployeePaymentInput = {
  bankCode?: string | null;       // Nonblank, max 30
  bankName?: string | null;       // Nonblank, max 100
  accountNumber?: string | null;  // Exactly 10 digits; retain leading zeroes
  accountName?: string | null;    // Nonblank, max 200
  amount?: string | null;         // Nonnegative decimal, max 16 integer digits, max 2 decimal places
  payFrequency?: 'weekly'|'bi-weekly'|'monthly'|'one_time';
  currency?: 'NGN';
};
```

`amount` is the employee salary/payment amount **per selected payFrequency**, not calculated annual income, tax, net pay or an automatic salary-component breakdown. Label it clearly and reuse the existing amount/frequency conventions. There is no new `salary`, `salaryInfo` or `accountDetails` nested object. Salary stays on BusinessEmployee, not EmployeeTaxProfile.

Omitted fields preserve current values. Explicit null clears nullable bank/amount fields. Frequency/currency cannot be cleared with null. Send only changed fields; do not accidentally erase existing values by submitting blank defaults. Use null intentionally for a clear action rather than empty strings. Salary may be absent; do not invent a zero salary. Display currency explicitly.

## Tax-profile save

Existing tax fields remain accepted: taxIdentificationNumber, taxResidenceState, taxResidenceCountry, employmentStartDate, employmentEndDate, taxResidencyStatus, pensionFundAdministrator, pensionAccountNumber, pensionContributionRate, employerPensionContributionRate, nhfApplicable, nhisApplicable, taxExemptionStatus, taxExemptionReason. Tax country is a two-letter uppercase code; salary currency currently supports NGN only. Nigerian residence state must match the existing backend state catalog. Dates are YYYY-MM-DD; employment end cannot precede start. Pension rates are percentage-point decimal strings between 0 and 100, up to four decimal places; never infer statutory defaults.

Example combined request:

```http
PUT /api/businesses/business-id/employees/employee-id/tax-profile
Content-Type: application/json
```

```json
{
  "taxIdentificationNumber": "123456789",
  "taxResidenceState": "Lagos",
  "taxResidenceCountry": "NG",
  "employmentStartDate": "2026-10-13",
  "pensionContributionRate": "8.0000",
  "bankCode": "058",
  "bankName": "GTBank",
  "accountNumber": "0012345678",
  "accountName": "Ada Example",
  "amount": "250000.00",
  "payFrequency": "monthly",
  "currency": "NGN"
}
```

The example pension rate is illustrative user-entered data, not a backend default or a PAYE calculation. This change stores setup information; tax computation, payment execution and bank verification remain separate workflows.

GET and PUT tax-profile now return:

```ts
{
  taxProfile: EmployeeTaxProfileResponse | null;
  employee: EmployeeResponse & {
    amount: string | null;
    payFrequency: 'weekly'|'bi-weekly'|'monthly'|'one_time';
    currency: 'NGN';
    bankCode: string | null;
    bankName: string | null;
    accountNumber: string | null;
    accountName: string | null;
  };
}
```

The existing taxProfile object contract is preserved; employee is additive. GET can return taxProfile:null without creating a profile, while still returning employee setup fields. PUT upserts tax data and updates only supplied employee payment fields within one database transaction. A tax-only PUT does not rewrite the employee. If any part fails, neither tax nor payment changes commit.

PATCH employee returns the existing `{employee}` summary; refresh GET employee detail to obtain current authorized bank fields. Saving account details does not mark the account verified or make payments payable. Account name/number and sensitive tax identifiers are encrypted at rest and decoded only in authorized responses.

When changing bank/account identity, submit the intended accountName with the changed fields. It is retained as unverified user-entered data; omitting it clears the old name and invalidates prior bank verification. Migration `20261013120000_employee_entered_account_name` preserves this behavior at the database level.

## Auditing and administrator inspection

The existing database-enforced `business.employee.updated` audit records **every real persisted bank/salary change**, whether made through PATCH employee or the combined tax-profile PUT. It includes employee/entity ID, actor, timestamp and flags `bankDetailsChanged`/`compensationChanged`. Tax-profile changes also generate the existing employee-tax-profile activity event. Mutation and audit commit/roll back together. Re-saving identical employee payment values does not manufacture another employee-change audit. Existing encrypted account values remain stable when unchanged.

Authorized administrators can already inspect the business audit feed with audit_logs:view. Add links/filter navigation when appropriate; audit presentation must remain permission-gated. Financial notifications continue through the existing in-app notification system.

Audit metadata intentionally excludes account numbers, account names, tax IDs and salary amounts. This is an activity record, **not** a complete before/after financial-value history. If later product requirements need administrators to compare old/new salary amounts, implement a separately authorized financial-history contract rather than exposing sensitive values through the general audit feed.

## Acceptance checks

1. Tax-profile completion can prefill and save salary plus account details in one request.
2. Edit employee uses the same payment section and existing PATCH route.
3. Employee detail exists, matches membership-profile styling, and provides permission-gated Add/Edit employee details.
4. Leading-zero account numbers and decimal salary strings survive round trips.
5. Partial saves preserve omitted fields; clear actions use intentional nulls.
6. Invalid salary/account/date input does not leave partially saved tax/payment data.
7. Missing update permission does not expose or permit editing private bank/salary fields.
8. Refresh relevant views after save; notifications/audits are backend-authored and no false verification/PAYE/payment success is displayed.
