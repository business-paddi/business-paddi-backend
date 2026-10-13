# Frontend handoff: email deep links, invitation details and authentication redirects

## Copy this prompt to the frontend agent

Inspect the existing invitation and authentication implementations first, then update every flow that already uses them. Keep the project's components and styling. The backend is updated; implement the frontend changes below without creating a separate callback convention.

### 1. Use the real invitations route

New invitation emails link to:

```text
http://localhost:3000/dashboard/invites?inviteId=<opaque-invite-id>
```

The origin comes from backend `FRONTEND_URL`; default `INVITE_FRONTEND_PATH` is now `/dashboard/invites`. The link contains **no token**. Acceptance by ID already requires an authenticated active account with verified ownership of the invitation's email, so the URL does not need a bearer secret.

Make the existing `/dashboard/invites` page read `inviteId`, load the singular endpoint below, and open/highlight that invitation regardless of the current list filter. Display the business name/photo, who invited the user (name/avatar), the offered role, expiry, invitation status and any approval requirement. Add a detail card/panel using existing components. An optional `/dashboard/invites/[inviteId]` page can use the same API; if implemented, have the dashboard query link route there. Do not make a new, unimplemented path the only working email destination.

Add a compatibility redirect from **`/business-invites`** for emails already sent by the old backend. Retain `inviteId`, redirect to `/dashboard/invites?inviteId=...`, and discard the legacy `token` query parameter. If there is no ID, redirect to the invitations list. Existing sent emails cannot be changed, and already queued email bodies stay frozen for provider idempotency. Keep tokens out of browser history and analytics; accepting by ID avoids needing them.

### 2. Preserve the existing `returnTo` convention throughout authentication

The inspected frontend already has `returnTo`, `getPendingReturnTo`, `setPendingReturnTo`, `sanitizeReturnTo` and `clearPendingFlow` in `src/lib/auth/pending-flow.ts`. Reuse and strengthen these; do not introduce `callbackUrl` alongside them.

Examples:

```text
/login?returnTo=%2Fdashboard%2Finvites
/login?returnTo=%2Fdashboard%2Finvites%3FinviteId%3Dabc123
/signup?returnTo=%2Fdashboard%2Finvites%3FinviteId%3Dabc123
```

An unauthenticated user clicking the email must retain the **complete local destination including `inviteId`** through login, switching to signup, email verification, password sign-in, login verification and Google OAuth. Query parameters should make the destination visible/recoverable on auth pages; the existing session-storage helper can retain it through multi-step and OAuth navigation. Preserve it on error/retry screens and login/signup cross-links as well.

On final successful authentication, refetch/confirm the cookie-backed current-user session, capture the validated destination, clear the completed pending flow, and navigate directly to it. Do not clear `returnTo` after registration or email verification if login is still required. Verification alone does not establish an authenticated session in the current backend; continue to login with the destination retained.

Specific gaps observed in the current frontend:

- `src/app/(auth)/login/page.tsx` and `login-verification/page.tsx` already consume pending `returnTo`. Extend this behaviour consistently rather than replacing it.
- `src/app/(auth)/verify-email/page.tsx` currently clears the whole pending flow before going to `/login?notice=email-verified`, losing the destination. Preserve it through verification and append it to the login destination.
- `src/app/(auth)/signup/page.tsx` must capture `returnTo` on entry and carry it to verification and login; its login cross-link must preserve it.
- `src/app/(auth)/auth/callback/page.tsx` currently clears the pending flow and always redirects Google success to `/dashboard`. Capture the stored safe destination first and use it instead. Keep it through Google verification-required, account-link-required and failure/retry branches.
- `src/components/auth/SessionBoundary.tsx` already constructs a full local path plus query when sessions expire. Preserve that behaviour for invitations and any future nested detail route.

Validate callbacks as **same-origin local paths**. The current sanitizer rejects `//` but does not reject backslashes; harden it. Reject external/protocol-relative destinations, backslashes, malformed URLs and auth-page redirect loops. Resolve against the frontend's own origin and check the parsed origin, not just a prefix. Do not allow a callback parameter to override the backend's OAuth state or Google's registered redirect URI. Google continues through the existing backend `/api/auth/google` and frontend `/auth/callback`; preserve the app destination separately using the existing pending-flow storage.

Callback values are frontend navigation state. **Do not add `returnTo` to backend registration/login/verification JSON bodies**, whose DTOs do not accept it.

### 3. Support recipients who have not registered yet

An invitation is stored by email even when there is no user account. Signing up does not automatically accept it or create business membership. The sequence is:

1. Open the invitation dashboard link and retain its destination.
2. Choose signup or login. Register with the **email that received the invitation**.
3. Verify that email using the existing verification flow.
4. Complete sign-in, including login verification if required.
5. Return directly to the selected invitation.
6. Show an explicit **Accept invitation** button; acceptance is a POST triggered by the user's click.

The personal invitations APIs match the signed-in account's email, so newly registered users can find previously created invitations even if they never received an in-app notification. Existing customers still receive a stored in-app notification at invitation creation.

Allow authenticated users with **no business membership** to reach `/dashboard/invites` and its optional detail route. Do not force business selection, business creation or business onboarding before they can accept the invitation. Prioritize a valid invitation destination over generic post-login onboarding navigation. Never accept automatically on page load or through a GET; email scanners may open links.

### 4. API contracts

Use the existing API client with cookies (`credentials: "include"` / Axios `withCredentials: true`). All routes below include the `/api` prefix. No existing business access is required to view or accept your own invitation.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/business-invites` | None | `{items: PersonalInvitation[]}`; 200 |
| **`GET /api/business-invites/:inviteId`** | None | `{invitation: PersonalInvitation, membership: InviteMembershipSummary \| null}`; 200 |
| `POST /api/business-invites/:inviteId/accept` | No body needed | `{invitation: Invitation, membership: Membership}`; 201 |

```ts
type PersonalInvitation = Invitation & {
  business: {id: string; name: string; profileImage: string | null};
  role: {id: string; name: string; key: string};
  invitedBy: {id: string; name: string; avatar: string | null};
};
type InviteMembershipSummary = {
  id: string; businessId: string; roleId: string;
  status: 'active' | 'pending_approval' | 'suspended' | 'removed';
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  approvalRequestedAt: string | null;
  approvalReviewedAt: string | null;
  approvalReason: string | null;
};
```

`Invitation` and the full acceptance `Membership` contracts are documented in [INVITE_EMAIL_AND_APPROVAL_HANDOFF.md](INVITE_EMAIL_AND_APPROVAL_HANDOFF.md). Both list and singular detail now include the safe `invitedBy` summary. The detail's membership summary is returned for an accepted invitation; it lets the recipient refresh and see pending approval, approval or rejection. It is null for an invitation not yet accepted or where no current membership exists.

Never expose token hashes, inviter email, employee financial/tax data or a public unauthenticated invitation preview. Details are scoped to the authenticated recipient's email. A missing invitation and an invitation belonging to another account both return **404**. Show “This invitation isn't available for this account” and offer a way to sign in with the invited email, without claiming an unknown ID belongs to somebody else. **401** requires the existing auth flow. Pending expired invitations are represented as `status: "expired"`; acceptance can return **410**. Already accepted/revoked/conflicting invites return **409** on acceptance.

After acceptance, refresh the invitation detail and personal list. If membership is `active`, refresh the businesses list and allow entry to the business. If it is `pending_approval`, show “Awaiting membership approval” and keep workspace actions disabled. Rejected memberships display their stored rejection reason. An accepted invitation alone does not prove that workspace access is active.

### 5. Verify end to end

Cover existing-user login, signup → email verification → login, login-verification challenges, Google login, expired sessions, auth cross-links/reloads, no existing business membership, wrong-email accounts, expired/revoked invitations, immediate membership and pending/approved/rejected membership. Check bare `/dashboard/invites` redirects as well as selected invitations. Check the old `/business-invites?token=...&inviteId=...` compatibility redirect and unsafe callback rejection. GET navigation must never create membership.

## Backend email changes

Every outgoing email now shares the invitation's branded layout and CID logo: email verification, login verification, email-change verification/notice, password-reset code/notice, security verification and business invitations. Code panels, five-minute expiry, security instructions and plain-text alternatives remain specific to their purpose. Account-email delivery and invite queue behaviour are preserved.

No new migration or backend callback field is required. Set `INVITE_FRONTEND_PATH=/dashboard/invites` if a deployment previously explicitly configured the old route. The development server was intentionally left stopped.
