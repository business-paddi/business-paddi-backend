# Invite email and membership approval handoff

> Email links and auth redirects have been updated. Read [EMAIL_AUTH_INVITE_FRONTEND_HANDOFF.md](EMAIL_AUTH_INVITE_FRONTEND_HANDOFF.md) for the current dashboard link, singular invitation endpoint, inviter summary and `returnTo` requirements.

This supersedes the invitation delivery and authority sections of [BUSINESS_FRONTEND_HANDOFF.md](BUSINESS_FRONTEND_HANDOFF.md). New invites and onboarding invitations now persist an encrypted email outbox record in the same PostgreSQL transaction as the invite and existing-user notification. The request returns `deliveryStatus: "pending"`; BullMQ sends through Resend afterward.

## Copyable frontend migration prompt

Search the frontend for every existing invitation, onboarding, personal-invitation dashboard, notification and member-profile flow. Update those implementations together using the contracts below. Reuse the existing API client, authentication transport, UI styling and singular member endpoint. Remove dummy invitation/approval data from connected flows.

All routes have the `/api` prefix. Authentication uses the existing `accessToken` cookie: send requests with `credentials: "include"` (Axios `withCredentials: true`) and use the existing refresh flow on 401. Use JSON request bodies. The backend derives the acting user from authentication: do not send inviter/user IDs, approval fields, token hashes or email delivery state. Unknown fields fail validation. IDs are opaque strings and timestamps are ISO strings or null.

| Method and route | Request | Response | Required access |
| --- | --- | --- | --- |
| `POST /businesses/:businessId/invites` | `{email, roleId?, employeeId?}` | `{invitation: Invitation}`; 201 | **Both** `members:invite` and `roles:assign` |
| `GET /businesses/:businessId/invites` | None | `{items: Invitation[]}`; 200 | `members:invite` |
| `POST /businesses/:businessId/invites/:inviteId/resend` | None | `{invitation: Invitation}`; 201 | Both invitation controls |
| `POST /businesses/:businessId/invites/:inviteId/revoke` | None | `{invitation: Invitation}`; 201 | `members:invite` |
| `GET /business-invites` | None | `{items: PersonalInvitation[]}`; 200 | Signed-in user; their email only |
| `POST /business-invites/:inviteId/accept` | None | `{invitation: Invitation, membership: Membership}`; 201 | Active user with the verified invited email |
| `POST /business-invites/accept` | `{token: string}` | Same acceptance response; 201 | Same verified-email requirement |
| `GET /businesses/:businessId/member-approvals` | None | `{items: ApprovalMember[]}`; 200 | Active member with `roles:assign` |
| `POST /businesses/:businessId/members/:memberId/approve` | None | `{membership: ReviewedMember}`; 201 | `roles:assign` and **all target effective grants** |
| `POST /businesses/:businessId/members/:memberId/reject` | `{reason: string}`; trimmed, nonempty, maximum 500 characters | Same review response; 201 | Same reviewer authority |

Default invitation role is the system employee role. Both invitation controls are mandatory even for that role. Owner invitations, foreign custom roles and inactive roles are rejected. Linked employee references must belong to the business, have the same email and be unlinked. Reactivating a suspended/removed member also requires `members:update_status`; an invite cannot replace their existing role. Active or pending-approval memberships cannot be invited again.

```ts
type Invitation = {
  id: string; businessId: string; email: string;
  employeeId: string | null; roleId: string; invitedByUserId: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  requiresApproval: boolean;
  deliveryStatus: 'pending' | 'sent' | 'failed';
  deliveryGeneration: number; deliveryAttempts: number;
  deliveryProviderId: string | null; deliverySentAt: string | null;
  deliveryLastError: string | null;
  expiresAt: string; acceptedAt: string | null; revokedAt: string | null;
  createdAt: string; updatedAt: string;
};
type PersonalInvitation = Invitation & {
  business: {id: string; name: string; profileImage: string | null};
  role: {id: string; name: string; key: string};
};
type Role = {
  id: string; businessId: string | null; name: string; key: string;
  type: 'system' | 'custom'; status: 'active' | 'archived';
  grantedPermissions: string[]; deniedPermissions: string[];
  effectivePermissions: string[];
};
type Membership = {
  id: string; businessId: string; userId: string; roleId: string;
  status: 'active' | 'pending_approval' | 'suspended' | 'removed';
  invitedByUserId: string | null;
  roleUpdatedByUserId: string | null; roleUpdatedAt: string | null;
  statusUpdatedByUserId: string | null; statusUpdatedAt: string | null;
  removedByUserId: string | null; removedAt: string | null;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  approvalRequestedAt: string | null; approvalReviewedAt: string | null;
  approvalReviewedByUserId: string | null; approvalReason: string | null;
  createdAt: string; updatedAt: string; role: Role;
};
type MemberUser = {id: string; name: string; email: string; avatar: string | null};
type ApprovalMember = Membership & {user: MemberUser; canApprove: boolean};
type ReviewedMember = Membership & {user: MemberUser};
```

If the inviter holds every target effective permission, acceptance returns `active` / `not_required`; enter the workspace immediately. Otherwise acceptance returns `pending_approval` / `pending`: show “Awaiting membership approval” and disable workspace actions. This is successful acceptance, not an error. Pending members have no effective permissions and are excluded from their active-business list. The review requirement is persisted at creation and rechecked at acceptance; losing authority cannot silently elevate the recipient. The inviter must still hold both invitation controls when the invite is accepted.

An approver must be active in the same business, hold `roles:assign` and possess all current target grants after subtracting denials. “Higher-up” is determined by permissions, not role names. Self-review is rejected. `canApprove` is a display hint; the POST rechecks authority. Approval sets `active` / `approved`; rejection sets `removed` / `rejected`. Reviewer ID, time and rejection reason are stored. Refresh member, approval and active-business queries after review.

Continue using `GET /businesses/:businessId/members/:memberId` for the comprehensive member profile and optional employee details described in the original handoff. Member list/profile responses now include the approval fields; their role's `effectivePermissions` is empty while membership is inactive or pending. Existing notification contracts remain unchanged: `GET /notifications` and `PATCH /notifications/:notificationId/read`. Existing users still get stored invitation notifications independently of email delivery. Review outcomes do not yet generate a second notification.

### Email landing route and delivery UI

The CTA links to `${FRONTEND_URL}${INVITE_FRONTEND_PATH}?inviteId=...`; default path: `/dashboard/invites`. New links contain no token. Implement that route or configure the backend to the existing route. Preserve the invitation through sign-in/signup and email verification. Load personal invitation details after login. Acceptance must be an explicit user-triggered POST; never accept on page load or via GET because email scanners open links. Prefer accepting by ID after verifying the signed-in email. Clear token query parameters from browser history after capturing the invitation, and omit them from analytics/logs. There is no new unauthenticated token-preview endpoint.

`sent` means Resend accepted the message, not inbox delivery. A mail failure does not invalidate the invitation; existing customers can still accept from their dashboard. A resend while delivery is pending/processing reuses the existing delivery. After success or permanent failure, an explicit resend creates a new generation and token; this is an intentional additional email. Successful sends have a one-minute resend cooldown. Do not automatically invoke resend in frontend retry loops.

- `403 / MISSING_ACCESS_CONTROL`: response includes `missingPermissions`; show the missing invitation controls.
- `403 / ROLE_EXCEEDS_AUTHORITY`: reviewer lacks target grants; response includes `missingPermissions`.
- Other `403`: wrong/unverified email, inactive actor/business or lost inviter authority.
- `409`: membership conflict, repeated review, no longer pending or resend cooldown.
- `409 / DELIVERY_UNCERTAIN`: previous email may have succeeded; disable resend pending operator reconciliation.
- `410`: expired invite at acceptance; create a new invite.
- `400`: invalid token, role, employee or request body. Expired/revoked invitations cannot be resent (409).

## Backend deployment and reliability

Apply migrations, build and start normally (`npm run start:dev`, configured port 5000). Worker and relay run in the API process using `REDIS_URL`. Redis authentication, selected database and `rediss://` are supported. Existing `RESEND_KEY` and `RESEND_FROM_EMAIL` are used; the sender domain must be verified in Resend. `FRONTEND_URL` sets the frontend origin; `INVITE_FRONTEND_PATH` must be an absolute route on it, without query or fragment.

`INVITE_EMAIL_ENABLED=false` disables processing on a replica while leaving durable writes enabled. At least one replica must process mail. `INVITE_EMAIL_QUEUE_PREFIX` optionally separates environments; producers and workers must agree (default `bull`). Configure production Redis with persistence/AOF, backups and `maxmemory-policy noeviction`.

PostgreSQL is authoritative. A ten-second relay recreates due jobs after Redis outages/lost jobs and expired worker leases. Queue jobs contain only delivery IDs. Full immutable provider payloads are AES-256-GCM encrypted and bound to their delivery ID. The key uses a separate derivation purpose from `VERIFICATION_CODE_PEPPER`; keep the secret consistent between replicas and do not rotate it while invitations are undrained. Sent/cancelled ciphertext is cleared; failed/uncertain ciphertext remains available for investigation.

Each generation has one outbox record, a stable BullMQ job ID and a stable Resend idempotency key. A database lease prevents ordinary concurrent submissions. Provider idempotency covers acceptance followed by a crash or failed database commit; retries always reuse exactly the same key and body. Transient network/429/5xx and concurrent-idempotency errors use exponential backoff starting at 30 seconds, with at most six attempts. Permanent provider errors stop. Retries stop 23 hours after the first attempt, before Resend's 24-hour deduplication limit. Ambiguous exhausted deliveries persist as `uncertain` and cannot be manually resent. External delivery cannot provide an unconditional exactly-once guarantee beyond its deduplication window; terminal state/attempt history must not be reset.

Uncertain deliveries require operator reconciliation using Resend logs and the stable `business-invite/<deliveryId>` key; confirm whether the provider accepted the message before any audited recovery action. No unrestricted terminal-reset endpoint is provided. Legacy pending invitations with discarded raw tokens are not bulk emailed: explicit resend creates a new encrypted delivery/token. Accepted/revoked/expired invitations are not backfilled. Acceptance/revocation cancels pending work; a message already being submitted cannot be recalled.

Email layout uses the site's BusinessPaddi mark and navy/blue styling, a CID PNG logo, escaped content, accessible tables, a large CTA and a plain-text alternative. Authentication verification emails retain their separate implementation.

Validation: `npm test -- --runInBand`, `npm run db:test:invites`, `npm run lint`, `npm run build`. The integration script creates/removes an isolated schema and Redis queue and uses a fake provider exclusively.

The official [Resend Email Best Practices skill](https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/SKILL.md) informed the template/reliability implementation. Resend MCP was unavailable because its plugin was not installed/connected; runtime uses the existing official SDK. [Resend idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys) specifies the 24-hour window.
