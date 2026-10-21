# Policy chat: frontend implementation handoff

This is the entry flow for policy creation. Replace the first form-style class setup screen with a conversation driven by server messages and reply buttons. The backend handles personalization, wording, class choices, and the next step. The frontend owns the visible transcript. No AI, chat database table, or migration is required for this version.

This document supersedes the onboarding-dialog instructions in `SIMPLE_POLICY_FRONTEND_HANDOFF.md`. The existing policy CRUD and assignment APIs remain available; they have not changed. Scope of this chat slice ends when a class is selected. AI drafting is temporarily disabled. On `nextStep.type: policy_form`, open the existing policy form with the selected class. Use the existing preview and create endpoints to save it.

## UI behavior

On opening Policies/Create policy, load the chat from the backend. Display each `messages` entry as an assistant bubble. Under the latest assistant turn, render the returned `replies` as buttons in their returned order. Display the class-name composer only when `input.kind` is `class_names`. Otherwise show buttons only—there is no general free-text chat input in this slice.

For a new business with no policies or classes, the assistant greets the authenticated user by first name, names the business, briefly explains policies and classes, and offers “I want to create a class”. For a business with existing classes, it lists them as “Use Vacation”, “Use Benefits”, etc., plus a create-class choice. A business with classes but no policies uses that existing-class path. Newness means business data, not the user's account age or their first browser visit. There is no first-visit tracking table.

### Flow

1. `GET chat` → greeting, explanation when needed, available class choices.
2. Click “I want to create a class” → send its request → assistant asks for class names and returns suggestion buttons plus a small chat composer.
3. Click “Create Benefits”, or type `Holiday and Vacation` and submit → backend saves classes through the existing audited class service → assistant confirms the result and returns current class-choice buttons.
4. Click “Use Vacation” → backend validates the class against the current business → assistant confirms the selected class and returns `step: policy_ready`, `selectedClass`, and `nextStep`.
5. Keep the selected class in local draft state. This completes the implemented chat slice. A subsequent policy-description turn is a future addition. Show the assistant confirmation and “Choose a different class” / “Create another class”; do not present a free-text field that has no supported submit action.

The onboarding chat does not require employee groups, so do not block these steps with “Create an employee group first”. Groups will matter during policy targeting later.

## Transport

Use the existing configured backend origin (currently local port 5000), `/api` prefix, and cookie authentication. Use `credentials: 'include'` for fetch and `Content-Type: application/json` for POST. Do not send a user name, user ID, business name, role, transcript, or fabricated context; the backend derives them from authentication and current tenant data. Render all message/name strings as plain text, not HTML.

| Method | Full route | Success |
| --- | --- | --- |
| GET | `/api/businesses/:businessId/policies/chat` | 200 |
| POST | `/api/businesses/:businessId/policies/chat/replies` | 200, including class creation |

`policies:view` is required for both endpoints. `create_class`, `save_classes`, and `use_class` additionally require `policies:create`. Read-only users receive `step: read_only`, an explanation, and a help button, with no creation controls. The old class creation endpoint still returns 201; chat replies always return 200 on success.

## Response contract

```ts
type ClassRef = { id: string; name: string };
type ReplyRequest = {
  action: 'restart' | 'help' | 'create_class' | 'save_classes' |
    'choose_class' | 'use_class';
  classId?: string;
  names?: string[];
  text?: string;
};

type PolicyChatResponse = {
  flowVersion: 1;
  mode: 'guided';
  step: 'create_class' | 'choose_class' | 'policy_ready' | 'read_only';
  context: {
    businessId: string;
    businessName: string;
    firstName: string;
    policyCount: number;
    classCount: number;
    canCreate: boolean;
  };
  messages: Array<{ id: string; role: 'assistant'; text: string }>;
  classes: ClassRef[];
  replies: Array<{ id: string; label: string; request: ReplyRequest }>;
  input: { kind: 'none' } | {
    kind: 'class_names';
    field: 'text';
    placeholder: string;
    maxLength: 2000;
    submitLabel: string;
    submit: { action: 'save_classes' };
  };
  selectedClass?: ClassRef;
  nextStep?: { type: 'policy_form'; classId: string };
  effect?: {
    type: 'classes_saved';
    classIds: string[];
    createdCount: number;
  };
};
```

Each response contains only that turn's assistant messages, not the entire conversation. IDs identify messages inside the transcript; they are not server session IDs. Store them with a locally generated user bubble for each submitted button/text. `replies` and `input` replace the latest available controls. Only the latest turn's reply buttons should remain clickable. Prior turns remain readable in the transcript.

`create_class` initially can have `input.kind: none`: the first turn asks the user to click the create-class reply before opening the composer. Use `input.kind`, not `step`, to decide whether text entry is enabled.

## Example: new business

GET returns a response shaped like:

```json
{
  "flowVersion": 1,
  "mode": "guided",
  "step": "create_class",
  "context": {
    "businessId": "business-id",
    "businessName": "Acme",
    "firstName": "David",
    "policyCount": 0,
    "classCount": 0,
    "canCreate": true
  },
  "messages": [
    { "id": "message-1", "role": "assistant", "text": "Hey David, welcome to Business Paddi’s policy engine. Let’s define the rules Acme will live by." },
    { "id": "message-2", "role": "assistant", "text": "A policy describes a rule or benefit for people in your business—for example, who can take a vacation or receive a work benefit." },
    { "id": "message-3", "role": "assistant", "text": "Classes group policies by what they relate to, such as Payments, Vacation, Benefits, Work equipment or Documents. You choose the names that fit your business." },
    { "id": "message-4", "role": "assistant", "text": "You do not have any classes yet. Let’s start there." }
  ],
  "classes": [],
  "replies": [
    { "id": "create_class", "label": "I want to create a class", "request": { "action": "create_class" } },
    { "id": "help", "label": "Explain policies and classes", "request": { "action": "help" } }
  ],
  "input": { "kind": "none" }
}
```

Send exactly the clicked `reply.request`, not the response, reply label, or whole reply object:

```json
{ "action": "create_class" }
```

The assistant returns its class-name question, suggestions such as “Create Benefits” (request `{ "action": "save_classes", "names": ["Benefits"] }`), and the composer definition. Suggestions create real classes immediately when clicked; do not treat them as selected draft chips or save them on page load.

For a custom reply, submit:

```json
{ "action": "save_classes", "text": "Holiday and Vacation" }
```

The full sentence `Create classes Holiday and Vacation` works too. Custom names are dynamic. Existing parsing accepts comma, “and”, semicolon, newline, or `&` separators, 1–20 names, each no more than 100 characters. Names allow letters, numbers, spaces, apostrophes, parentheses, slashes and hyphens. Use `names` instead of `text` if the UI already maintains separate chips; never send both modes. Do not use literal `and` as part of a single name in text mode; separate names explicitly through `names` when necessary.

The result includes `effect.type: classes_saved`, IDs and `createdCount`, and returns the current choice buttons. Existing class names are reused case-insensitively. Repeating the same class save does not create another record or another creation audit. If `createdCount` is zero, the assistant says the classes already exist.

Selecting a class uses its actual returned ID:

```json
{ "action": "use_class", "classId": "vacation-class-id" }
```

The response includes:

```json
{
  "step": "policy_ready",
  "selectedClass": { "id": "vacation-class-id", "name": "Vacation" },
  "nextStep": { "type": "policy_form", "classId": "vacation-class-id" },
  "input": { "kind": "none" }
}
```

The actual response also includes the common context/messages/classes/replies fields. `nextStep` is a state handoff, not a URL or a request to send automatically. Selecting a class creates neither a policy nor an employee assignment.

## Local state and edge cases

- Keep `{transcript, latestResponse, pendingRequest, selectedClass}` in the policy chat component/state store. Reuse the existing auth and data-fetching stack. No new chat SDK is necessary.
- GET on first open starts a fresh transcript. Deduplicate initial loading in React Strict Mode. Background polling/refetches must not append a new greeting over an active conversation.
- For each interaction, append a user bubble showing the clicked label or submitted text, mark it pending, and disable controls until the response arrives. On success, append new assistant messages, replace controls, and update selected class only from the authoritative response. When a response has no `selectedClass`, clear a previous selection.
- Restart (`{action: restart}`) uses current database data. Replace the old transcript on explicit restart; class/policy records are preserved.
- `help` explains the concepts and returns current choices. `choose_class` goes back to those choices. Returning to choices clears the selected class. Both have no side effects.
- A foreign/deleted/stale `classId` returns conversational feedback and current valid choices, without setting `selectedClass` or `nextStep`.
- Invalid class-name syntax returns HTTP 200 with a corrective assistant message and the class-name composer, without an `effect`. Keep the submitted text available for editing; do not show a saved toast.
- Wrong JSON types, missing/unknown actions, incompatible action fields, or both `text`/`names` produce HTTP 400. Nest validation messages may be arrays. Unknown request properties are rejected. Never echo response fields back into the reply payload.
- On 401 use existing auth recovery; on 403 show the permission error and refresh chat context; on 404 business access is unavailable. For 5xx/network failures keep the draft/user bubble and show a retry action. Never replace a database failure with a fake assistant success.
- Class saves are idempotent by normalized name, so retrying the same class-name request is safe. Retrying a successful request may say “already exists”, which is expected. Do not auto-submit another suggestion or a later policy save.
- On business/user changes, clear transcript, selection and pending controls. Ignore responses for previous businesses and stale requests. Scope any cached initial chat by business and authenticated user. Do not persist transcripts globally in localStorage.
- After `effect.type: classes_saved`, invalidate the existing policy setup/classes query. The chat response already contains fresh classes; avoid appending a second initial greeting when caches refresh.
- Render assistant/user bubbles and class names as plain text. Do not use the chat transcript as authorization or send it to the backend.

## Acceptance checks

1. No classes/policies: greeting contains the real user's first name and business name; policies/classes are briefly explained, with one create-class path.
2. Existing classes and zero policies: class choices appear rather than forcing another class setup.
3. Returning business with policies: greeting does not claim this is its first policy.
4. “I want to create a class” opens the inline composer and suggestion replies, with no records created merely by opening it.
5. Typing “Holiday and Vacation” creates/reuses both, shows the assistant confirmation, and returns selectable class IDs.
6. Clicking “Use Vacation” confirms that actual business class, sets `policy_ready`, and does not save a policy or an assignment.
7. Missing groups do not block greeting, class creation, or class selection.
8. Invalid names, duplicate names, stale/foreign class IDs, permission denial, help/back/restart, double-clicks and network errors behave as described.
9. A read-only user never sees a create/select-for-creation control and cannot bypass permissions by forging an action.
10. The first version stops cleanly at class selection; it does not imply an AI conversation or accept unsupported policy-description messages.
