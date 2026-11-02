# Simple policy creation

> The new conversational entry flow is documented in [POLICY_CHAT_FRONTEND_HANDOFF.md](./POLICY_CHAT_FRONTEND_HANDOFF.md). Use that flow for greetings and class creation/selection; the CRUD API details below remain valid.

This first version has classes, policies, existing employee groups, and explicit employee policy assignments. There is no separate rule model, cardinality, AI, conflict resolver, or resource enforcement. Policies record a group, an inclusive calendar date window, and an optional duration allowance in calendar days. Any class can be used; no built-in vacation-specific behavior is inferred.

## Frontend implementation brief

Build a Policies page in the selected business and a “Create policy” dialog. Keep implementation terms such as rules, cardinality, reconciliation, and parsing out of the user interface. The dialog should feel like guided setup with a text entry option and a form option.

1. Load setup and the policy list. Show an empty state with “Create your first policy” when there are no policies.
2. If setup contains no classes, show “How would you like to group your policies?” with the backend explanation and example chips such as Holiday, Vacation, Work grants, and Documents. Chips are suggestions, not preset records. Let users type “Create classes Holiday and Vacation” or add class names through a form.
3. Save classes, refresh setup, display the returned success message, and advance to the policy description step. If classes already exist, start here and provide “Manage classes” as an add-class action only; edit/delete endpoints do not exist yet.
4. Offer “Describe your policy” and “Use a form”. Display an example using the business's real class/group names when available. Do not suggest Engineering if the business has no Engineering group.
5. Submit the description to preview. Render returned questions as inline controls and preserve all previous input. Submit answers to preview again until it returns `ready`.
6. Show a review card with policy name, class, group, allowance if present, inclusive dates, and eligible employee count. Label the count “Employees currently in this group”, not “Employees assigned”. The count can change before saving.
7. “Create policy” saves the reviewed payload. On success, close the dialog, refresh the list, and offer “Assign employees”. Saving a policy does not assign anyone.
8. The assignment dialog lets the user choose an active employee belonging to the policy group and save one assignment at a time. There is no bulk assignment endpoint.

If no groups exist, show “Create an employee group first” and link to the existing group form. Refresh setup when returning. Do not create groups automatically from an unrecognized phrase.

Use a small local state machine: `loading → classes (if needed) → compose → clarifying → review → saving → success`. A failure keeps the last editable state and input. Cancel clears the local draft; there is no saved draft or chat-session endpoint. Clear business-specific state when switching businesses. Ignore stale preview responses when a newer request or business switch occurs.

## Transport and endpoint map

All paths below are relative to the **`/api` prefix**. For example, setup is `/api/businesses/:businessId/policies/setup`. Use the application's configured backend origin; local default is port 3001. Reuse the authenticated HTTP client with cookies (`credentials: 'include'` for fetch). Authentication uses an HttpOnly `accessToken` cookie; do not construct a bearer token or send actor/user IDs. POST requests use `Content-Type: application/json`. Browser origins must match the configured frontend origin.

| Method | Path after `/api` | Success | Required permissions |
| --- | --- | --- | --- |
| GET | `/businesses/:businessId/policies/setup` | 200 | `policies:view` |
| POST | `/businesses/:businessId/policies/classes` | 201 | `policies:create` |
| POST | `/businesses/:businessId/policies/preview` | 200 | `policies:create` |
| POST | `/businesses/:businessId/policies` | 201 | `policies:create` |
| GET | `/businesses/:businessId/policies` | 200 | `policies:view` |
| POST | `/businesses/:businessId/policies/:policyId/assignments` | 201, including an existing assignment | `policies:assign` |
| GET | `/businesses/:businessId/policies/employees/:employeeId/assignments` | 200 | `policies:view` and `employees:view` |

The guided flow needs both `policies:view` and `policies:create`. Hide creation/assignment actions when permission is missing, while still handling server authorization errors. An assignment picker that reads the employee list also needs `employees:view`.

Creation responses are plain objects, not nested under `data` by the backend. Adapt to any wrapping introduced by your HTTP library. There are no update, archive, delete, policy detail, conflict preview, document upload, or policy-specific audit endpoints in this slice. Policy details for list/review come from list/create results.

```ts
type PolicyDraftRequest = {
  text?: string;          // 1–2000 characters
  name?: string;          // 1–200 characters; otherwise generated
  classId?: string;       // existing class in this business
  groupId?: string;       // active group in this business
  durationDays?: number;  // integer 1–3650, optional
  startsOn?: string;      // YYYY-MM-DD
  endsOn?: string;        // YYYY-MM-DD
  year?: number;          // integer 1900–9999; used to complete parsed dates
};

type PolicyQuestion = {
  field: 'text' | 'name' | 'classId' | 'groupId' |
    'durationDays' | 'startsOn' | 'endsOn' | 'year';
  message: string;
  options?: Array<{ id: string; name: string }>;
};

type PolicyPreview = {
  status: 'needs_input' | 'ready';
  draft: PolicyDraftRequest;
  questions: PolicyQuestion[];
  eligibleEmployeeCount: number;
  assignmentMode: 'explicit';
};
```

The global validator rejects unknown request properties. Send only the fields above. Omit unset optional fields instead of sending empty strings or `null`; send numeric fields as JSON numbers. For a text flow, retain the original `text` and merge explicit answers. If the user edits the original description, clear old inferred fields and preview again so stale selections/dates cannot override the new description. When switching to the form, explain any unsupported restriction and let the user deliberately confirm the structured policy; never silently drop their text.

| Question field | UI control |
| --- | --- |
| `classId`, `groupId` | Select from the returned `options`, using IDs as values; show a create-class/group path when options are empty |
| `startsOn`, `endsOn` | Date picker returning `YYYY-MM-DD` |
| `year` | Whole-number year input |
| `durationDays` | Whole-number day allowance input |
| `name` | Short text input |
| `text` | Editable original description with the returned explanation and a form option |

## Complete follow-up and save example

After the missing-year response shown below, send this to preview:

```json
{
  "text": "Create a Vacation policy for employees in Engineering for one week during December from the 18th to 25th December",
  "year": 2026
}
```

Expected ready fields include `classId`, `groupId`, `durationDays: 7`, `startsOn: "2026-12-18"`, `endsOn: "2026-12-25"`, generated `name`, and `questions: []`. The review card uses those resolved names/values. Submit the same request to create after the user reviews it.

Example create response (IDs and timestamps are illustrative):

```json
{
  "success": true,
  "message": "Policy created successfully.",
  "policy": {
    "id": "policy-id",
    "businessId": "business-id",
    "classId": "vacation-class-id",
    "groupId": "engineering-group-id",
    "name": "Vacation — Engineering",
    "sourceText": "Create a Vacation policy for employees in Engineering for one week during December from the 18th to 25th December",
    "durationDays": 7,
    "startsOn": "2026-12-18T00:00:00.000Z",
    "endsOn": "2026-12-25T00:00:00.000Z",
    "createdByUserId": "authenticated-user-id",
    "createdAt": "2026-10-16T10:00:00.000Z"
  },
  "eligibleEmployeeCount": 12,
  "assignmentMode": "explicit"
}
```

Stored date fields serialize as UTC midnight timestamps. Treat them as calendar dates: use their first ten characters for date inputs and display formatting that cannot shift them to the previous day in a negative UTC offset. Determine scheduled/current/ended display labels against the selected business/user calendar date. This is a frontend display label, not a server status field.

Disable save while a mutation is in flight. Class creation and assignment retries reuse existing records. **Policy creation has no idempotency key or duplicate detection**: do not automatically retry it after an ambiguous timeout. Refresh the list and ask the user to check whether the policy was created before retrying.

## Errors and feedback

Preview can return HTTP 200 with `status: needs_input`; that is a normal clarification step. Creating an incomplete policy returns HTTP 400 with the same preview object at the root, including questions. Handle this shape before generic HTTP errors and return to clarification without losing input.

Other errors use Nest-style `{statusCode, message, error?}`; `message` can be a string or an array of validation messages. HTTP 401 should use the existing session recovery/sign-in flow. HTTP 403 means missing permission, inactive business/membership, or a rejected browser origin. HTTP 404 can mean the selected business/employee/policy is unavailable; clear stale references and refresh context. HTTP 409 means a duplicate database record. HTTP 400 on assignment can mean the employee is inactive or no longer belongs to the active policy group; refresh the picker and show the returned message. Unexpected failures show a retry action without discarding the draft.

Do not show success on preview or create success before the save request completes. Announce returned questions/errors accessibly, move focus to the first unresolved control, and keep the review/save actions keyboard-accessible.

## List and assignment screen details

Policy list responses have `{items,nextCursor}`. Each item includes policy fields, `policyClass`, `group: {id,name,status}`, and `_count: {assignments}`. Render name, class, group, allowance if present, date window, and assigned count. Fetch additional pages with `?cursor=<nextCursor>`; a `null` cursor ends pagination. No server search/filter parameters are supported for this list yet.

Reuse `GET /api/businesses/:businessId/employees?status=active&page=1&pageSize=20&search=...` for the assignment picker. This employee endpoint uses page pagination, not cursors, and has no group filter. Verify membership using `GET /api/businesses/:businessId/employees/:employeeId`, whose response has `employee.groupIds`, before presenting that employee as eligible; the assignment POST remains authoritative. Do not filter a single page and claim that it contains all eligible employees. Reuse existing group-management UI rather than inventing a new policy-specific employee directory.

Assignment creation returns `{success:true,created:true,assignment}` or `{success:true,created:false,assignment}`. An assignment contains `id`, `businessId`, `policyId`, `employeeId`, `createdByUserId`, and `createdAt`. Show “Already assigned” for `created:false`. Employee assignment list items contain the assignment plus `policy`, which includes `policyClass`; the response also has `nextCursor`.

On class creation, invalidate setup. On policy creation, invalidate the business policy list and setup if needed. On assignment creation, invalidate the business policy list (its counts) and that employee's assignment pages. Scope every query key to `businessId`, and scope assignment queries to `employeeId` too.

## Frontend acceptance checks

- A new business can create Holiday and Vacation classes and immediately move into policy creation.
- Existing classes are selectable, and submitting their names again does not produce duplicates.
- The exact December example asks for the year; a month-only example asks for start/end dates.
- Completing questions produces a review card and then saves the policy successfully.
- The form can create a policy without text and supports a cross-month date window.
- Unknown classes/groups produce selections or a create path, not invented records.
- “Except contractors” remains unresolved; selecting a group does not silently remove the restriction.
- Invalid dates, reversed ranges, oversized allowances, and empty options preserve the input and display actionable feedback.
- Saving a policy shows eligible count separately from assigned count; no employees are assigned automatically.
- Assigning an eligible employee succeeds, retrying shows already assigned, and an ineligible employee is rejected.
- Pagination, cookie authentication, missing permissions, business switching, stale previews, and mutation timeouts follow the behavior above.

## Onboarding dialog

Call `GET /businesses/:businessId/policies/setup`. It returns `help`, existing `classes`, and active `groups`. Display `help.classes` alongside examples. Classes are organization labels, not limits on how many policies an employee may receive. Reuse the existing business group creation and employee group membership forms.

Create classes with `POST /businesses/:businessId/policies/classes`:

```json
{ "text": "Create classes Holiday and Vacation" }
```

Or submit `{ "names": ["Holiday", "Vacation"] }`. Choose one input mode. Commas, “and”, semicolons, newlines, and `&` separate class names in text. Multiword labels work. Existing names are reused case-insensitively, and only newly created classes produce creation audits. The result contains `success`, `message`, `classes`, and `createdCount`. Display the success message and open policy creation.

## Policy conversation

Call `POST /businesses/:businessId/policies/preview`:

```json
{
  "text": "Create a Vacation policy for employees in Engineering for one week during December from the 18th to 25th December"
}
```

Given an existing Vacation class and Engineering group, the result is:

```json
{
  "status": "needs_input",
  "draft": {
    "text": "Create a Vacation policy for employees in Engineering for one week during December from the 18th to 25th December",
    "classId": "<vacation-class-id>",
    "groupId": "<engineering-group-id>",
    "durationDays": 7,
    "name": "Vacation — Engineering"
  },
  "questions": [{ "field": "year", "message": "Which year should these dates apply to?" }],
  "eligibleEmployeeCount": 12,
  "assignmentMode": "explicit"
}
```

The count is illustrative. Render each question as a form control using `field` and `message`; reference questions include `options` with `{id,name}`. Retain the original request locally and resubmit it with answers, such as `year: 2026`. No server-side chat session is required. Responses are not DTOs: send only supported request fields, not `status`, `questions`, or count fields. Dates and numeric answers should use date pickers/numeric controls rather than another free-text message.

If only “during December” is given, the backend asks for `startsOn` and `endsOn`; it does not manufacture days. Missing years are requested explicitly. Dates must be real ISO dates. Both date boundaries are inclusive: December 18–25 contains eight calendar days; a seven-day allowance is separate and fits within that window. An allowance longer than the window is rejected.

When the preview returns `status: ready`, show its structured draft for review. Submit the same original text plus answers to `POST /businesses/:businessId/policies`. Creation reruns validation and returns `{success,message,policy,eligibleEmployeeCount,assignmentMode}`. Incomplete creation returns HTTP 400 with `status: needs_input`, `draft`, and `questions` and writes nothing. A preview alone never saves anything.

## Direct form

The preview and create endpoints also accept this payload without text:

```json
{
  "name": "Engineering December vacation",
  "classId": "<vacation-class-id>",
  "groupId": "<engineering-group-id>",
  "durationDays": 7,
  "startsOn": "2026-12-18",
  "endsOn": "2026-12-25"
}
```

`name` defaults to the class and group names. `durationDays` is optional; the date window, class, and group are required. Cross-month/year windows work through the form. Text supports English full month names, day ordinals, days/weeks with digits or words one–ten, and one group per policy. The supported sentence pattern is `[Create a] <class> policy for [employees in] <group> [for <quantity> days/weeks] [during <month> [year]] [from <day> [month] to <day> [month] [year]]`.

Unsupported clauses block text creation and return a `text` question. Offer editing the sentence or opening the form; do not automatically remove the text or its restrictions. This version does not support tenure, employee-specific targeting, recurring allowances, negative conditions, multiple groups, document uploads, equipment allocation, or vacation requests. These require later model/engine additions rather than extra permissive parsing.

## Listing and assignments

- `GET /businesses/:businessId/policies?cursor=...`: up to 50 policies, class/group details, assignment count, and `nextCursor`.
- `POST /businesses/:businessId/policies/:policyId/assignments` with `{ "employeeId": "..." }`: explicit assignment to an active employee in the policy's active group. Retries return `created: false` without duplicate assignments/audits.
- `GET /businesses/:businessId/policies/employees/:employeeId/assignments?cursor=...`: up to 50 recorded assignments with policy/class details and `nextCursor`.

Creation does not automatically enroll the group. Assignments record the decision; they are not live access grants. They are not automatically revoked when dates end or group membership changes. Use the policy date window when displaying scheduled/current/ended records. Do not represent an assignment as authorization to another resource.

## Permissions, audit and database

All endpoints require authentication and active business access. Setup/list require `policies:view`; class creation/preview/policy creation require `policies:create`; assignment creation requires `policies:assign`; employee assignment listing requires both `policies:view` and `employees:view`. Existing groups use existing business endpoints/permissions. Actor identity is taken from authentication.

Audit events `business.policy.class_created`, `business.policy.created`, and `business.policy.assigned` use the existing AuditEvent store and commit in the same transaction as the record. Composite foreign keys prevent cross-business class, group, policy and employee associations. No separate policy audit table is introduced.

Migration: `prisma/migrations/20261016120000_simple_policies/migration.sql`. Applied successfully to the configured database on 16 October 2026 using `prisma migrate deploy`. Other environments must apply their migrations through the normal deployment workflow before serving these endpoints.
