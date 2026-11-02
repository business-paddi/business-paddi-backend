> Temporarily disabled for this release. The inference provider registrations and chat integration are commented out. No API request invokes OpenRouter. Class selection and stale `describe_policy` submissions return `policy_ready`, `input: { kind: "none" }`, and `nextStep: { type: "policy_form", classId }`. Open the regular policy form, then use the existing preview/create endpoints. The remainder of this document describes the preserved implementation for a future rollout.

# Policy chat inference — first iteration

Backend configuration: `OPENROUTER_KEY` in the backend environment. Uses `xingchen-agi/xing4.0-29b-a4b:free` with zero-priced provider routing, no paid fallback and no tools. Requests JSON mode with the extraction schema in the system prompt, then validates the returned shape on the backend. No new dependency or database migration. Classes remain deterministic; AI is used only when the person describes or refines a policy.

## Connect the existing chat

Routes retain cookie authentication and the `/api` prefix:

- GET `/api/businesses/:businessId/policies/chat`
- POST `/api/businesses/:businessId/policies/chat/replies`

Existing class creation/selection buttons still work. Selecting `use_class` returns step `policy_ready` and `input.kind: "policy_description"`. Render the returned assistant messages, then a text composer. The backend asks the person to describe the policy and affected groups/people. Submit `{...input.submit, [input.field]: typedText}`.

Example first description:

```json
{
  "action": "describe_policy",
  "classId": "existing-business-class-id",
  "text": "Allow all full-time employees in Engineering a one-week break during December."
}
```

The backend sends only bounded business reference data and the description/answers to OpenRouter. Employee names/IDs are supplied only when the caller has `employees:view`; no emails, salaries, bank accounts or user account records are sent. Up to 100 active references per directory are included in this first version. The model must ask when a reference is ambiguous/unavailable. Employee names are not resolved globally beyond the bounded supplied directory.

## Render the response

- `step: "clarify_policy"`: show `messages` and `inference.questions`. Questions contain `field`, `message` and optional current-business `{id,name}` options. Render names as text; options are context for answers, not API actions. People can answer in natural language, e.g. “I mean the Full time employment type, December 18–24, 2030.”
- `step: "review_policy"`: show the draft summary and grouped fields for review. This means sufficiently understood, **not saved, approved or enforced**.
- `inference.draft`: selected `classId`/`className`, proposed name, summary, `groupIds`, `employeeIds`, `employmentTypeIds`, `allEmployees`, `durationDays`, `startsOn`, `endsOn`, and plain-language `constraints`. Unknown scalar values are null; unknown selections are empty arrays.
- `inference.affectedPeople`: resolved group/employee/employment-type labels; `candidateCount` is null without employee-view permission or an unresolved audience. It counts active matching employees before evaluating additional constraints. `constraintsEvaluated` is always false. Do not label this count “eligible” or “approved”.
- Audience matching is `(any selected group OR named employees) AND selected employment types`. Employment type alone is valid. Everyone means active employees. Unsupported or ambiguous audience logic must be clarified/preserved in constraints.
- `inference.model`: actual serving model reported by OpenRouter. The backend currently pins one free model for consistent extraction.

## Continue the same draft

Both clarification and review responses expose `input.kind: "policy_clarification"`, `input.field: "answer"`, and `input.submit` containing the original description plus prior answers. Render a composer and submit `{...input.submit, answer: typedAnswer}`. The backend appends the new answer before re-running extraction. Preserve the **latest** returned submit object. Do not replace original `text` with the answer or send assistant messages as answers.

Example follow-up:

```json
{
  "action": "describe_policy",
  "classId": "existing-business-class-id",
  "text": "Allow all full-time employees in Engineering a one-week break during December.",
  "followUps": [],
  "answer": "December 18 through December 24, 2030."
}
```

This first version is stateless: the client retains the transcript and latest continuation while chatting. It does not add durable chat history or server-side resume. Maximum description 2000 characters; ten follow-up answers, 1000 characters each, 8000 characters combined. Once this limit is reached, offer a fresh description incorporating the answers. AI drafts are not stored in the database.

## Saving and current limits

`inference.persistence.canCreateWithCurrentApi` is true only for drafts representable by the current backend: exactly one group, exact valid dates and no extra constraints/individual/type/everyone targeting. When true, show an explicit confirm/create control using the existing POST `/api/businesses/:businessId/policies` with **exactly** `inference.persistence.createPayload`. Do not submit the original natural-language `text` to that endpoint: its existing parser is deterministic. The existing endpoint revalidates the supplied fields and permissions. This creates a recorded policy, not an enforced benefit/access grant or automatic employee assignment.

For more expressive drafts, `canCreateWithCurrentApi` is false, `createPayload` is null and `blockers` explains the storage limitation. Preserve/show the draft, disable creation through this flow, and allow refinement. Never drop tenure, employment type, named people, equipment quantities or other restrictions to make the draft saveable. Supporting persistence/enforcement for these is a future iteration, distinct from language inference.

The model handles interpretation and missing information; the backend also validates reference IDs, calendar dates, audience completeness, date ordering and allowance versus the inclusive window. There is no calibrated confidence score or conflict review in this version. A schema-valid draft can still be misunderstood; require human review.

## Errors and usage

- 400 invalid request/bounds; 403/404 existing tenant permissions and class selection.
- 429 free provider quota, duplicate in-flight request or local cap (10 calls per user/business per minute per process). Keep typed input and offer retry later. No automatic paid fallback or repeated retries. This cap is a basic process-local safeguard, not subscription billing or distributed quotas.
- 502 unusable provider draft/reference; 503 missing key, timeout or provider outage. Keep input, show the safe server message and allow retry/form fallback.
- Backend provider timeout is 45 seconds; give the browser a longer request timeout and disable duplicate submission while waiting.

Responses remain `flowVersion: 1`, `mode: "guided"` with additive inference states and input kinds. Existing class flows and manual policy endpoints are unchanged. Render model text as escaped plain text, not raw HTML. The API key stays on the server.
