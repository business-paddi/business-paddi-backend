# Notifications and business audit frontend handoff

Inspect and update the existing notification dropdown/inbox, business members, employee and inventory flows. Notifications are now general-purpose: **`invite` can be null**. Do not render every notification as a business invitation.

## API contracts

All routes require the existing verified, active account session cookie. Use `credentials: "include"` / Axios `withCredentials: true`.

| Endpoint | Response |
| --- | --- |
| `GET /api/notifications?limit=100&cursor=...&unreadOnly=true` | `{items: Notification[], nextCursor: string \| null, unreadCount: number}` |
| `GET /api/notifications/unread-count` | `{unreadCount: number}` |
| `PATCH /api/notifications/:notificationId/read` | `{notification: {id: string, readAt: string}}`; repeat reads preserve the timestamp |
| `PATCH /api/notifications/read-all` | `{updatedCount: number}`; marks this user's unread notifications only |
| `GET /api/businesses/:businessId/audit-events` | `{items: BusinessAuditEvent[], nextCursor: string \| null}` |
| `GET /api/audit-events` | Existing personal account/security audit contract remains available |

Mutations need no request body. Notification pagination defaults to 100, maximum 100, minimum 1. Use `nextCursor` for subsequent pages; `unreadOnly` accepts `true` or `false`. Foreign/missing cursors return 400; foreign/missing notification reads return 404. Empty lists and zero counts are valid. Responses use `Cache-Control: no-store`.

```ts
type Notification = {
  id: string; type: string;
  title: string | null; message: string | null;
  actionUrl: string | null;
  businessId: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null; createdAt: string;
  invite: (Invitation & {
    business: {id: string; name: string; profileImage: string | null};
  }) | null;
};
type BusinessAuditEvent = {
  eventId: string; businessId: string; userId: string | null;
  eventType: string; category: 'business';
  outcome: 'success' | 'failure' | 'blocked';
  severity: 'info' | 'warning' | 'error' | 'critical';
  metadata: Record<string, unknown> | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
};
```

Reuse `Invitation` from the existing invite handoff. Legacy invitation notifications retain their `invite` object; the API derives missing titles/action URLs from it. New general notifications carry their context in `data`. Display `title` and `message` as plain text, never injected HTML. Mark read separately from following the action. Refresh notification/unread queries after read/read-all and show fallback text for unknown types.

## Event types and destinations

| Type | Trigger and recipients |
| --- | --- |
| `business_invite` | Existing-user invitation creation; original behaviour retained |
| `membership_approval_requested` | Membership enters pending approval; active verified members holding `roles:assign` **and every effective target grant** |
| `membership_approved` / `membership_rejected` | Review outcome; affected user, with rejection reason in the message |
| `business_invite_accepted` | Invitation accepted; inviter |
| `membership_access_changed` | Membership role/status changes, or role configuration/grants/denials change; affected users |
| `employee_financial_details_changed` | Bank/compensation changes; linked employee and authorized payroll managers (`employees:view` + `employees:update`); editing manager excluded unless also the affected employee |
| `inventory_shortage` | New low/out-of-stock episode; active verified inventory managers with `inventory:view` + `inventory:manage` |
| `invite_delivery_failed` | Permanent failure or uncertain delivery of a still-pending invitation; inviter |
| `account_security` | Password/email changes, Google linking, completed password reset, two-factor changes, detected refresh-token replay, or a previously unseen browser signature; account owner |

`data` contains relevant IDs/flags such as `memberId`, `employeeId`, `productId`, `inviteId`, `roleId`, `approvalStatus`, `state`, `bankDetailsChanged`, `compensationChanged`, or `auditEventId`. It does not contain bank account numbers, salaries, tokens or passwords.

Follow `actionUrl` using same-origin navigation. Current destinations use existing routes: `/dashboard/invites?inviteId=...`, `/business/:businessId/members`, `/business/:businessId/employees`, `/business/:businessId/inventory/products/:productId`, `/dashboard/settings/security`, or `/dashboard`. Select the business context when following a business notification. Recheck current access on the destination; a notification is historical information, not an access grant. Reviewer/member pages must consume the existing member-approval API when the user has `roles:assign`; a reviewer may not have `members:view`.

On `invite_delivery_failed`, distinguish `state: "uncertain"`: previous delivery may have succeeded, so do not automatically resend. Use the existing delivery reconciliation/resend behaviour. On review outcome, refresh singular personal-invitation detail to obtain the current membership state. See [EMAIL_AUTH_INVITE_FRONTEND_HANDOFF.md](EMAIL_AUTH_INVITE_FRONTEND_HANDOFF.md) for preserving `returnTo` through authentication.

## Business audit UI

Require `audit_logs:view` and an active membership/business. Support `limit` (default 30, maximum 100), `cursor`, `eventType`, `actorUserId`, and ISO datetime `from`/`to` filters. Reset the cursor when filters change. Foreign/filter-incompatible cursors return 400. Missing permission returns 403; outsiders receive 404.

Render timestamp, event type, actor, outcome/severity and safe change/context fields. `metadata.actorName` provides a name snapshot when available; null actors represent system operations or database writes without application attribution. Event names are open strings; render unknown names gracefully.

Coverage includes business creation/updates; invitation creation/acceptance/revocation/expiry/resend/final delivery failure; member creation, role/status and approval changes; employee creation/updates, tax and group changes; employee-type/group changes; role definitions/grants/denials; and inventory movements (category, opening stock, edit, receive and sale). Inventory's detailed movement and price-history endpoints remain unchanged. Financial edits are recorded without financial values; tax values and invitation tokens are not copied into audits.

## Reliability and practical limits

Business events are database-triggered in the same transaction as the state change. Authorization mutations set a transaction-local actor ID; it never leaks between pooled transactions. Account security notifications are generated from persisted security audits, while two-factor notifications use actual stored preference changes. Existing best-effort auth failure audits remain best-effort; a failed audit write cannot produce a notification.

Per-user event keys prevent duplicate fanout. Bulk role/grant edits and employee financial edits within one transaction are grouped; no-op state updates produce no new alert. Stock alerts occur once per shortage episode, not on every stock update; a changed classification/threshold can start a new episode. Replay alerts are deduplicated per session.

“New browser” compares stored user-agent signatures; it is not hardware-level device identification. First-ever sign-in establishes the baseline without an alert; a known signature does not repeatedly notify. Stored inbox notifications are independent of the desktop/browser notification preference; client desktop alerts should respect that preference.

No historical notification backfill is performed. Membership mutations still enforce the existing authorization and approval rules; this change does not add role/status management endpoints. Server remains stopped pending the user's request to start it.

Validation: `npm test -- --runInBand`, `npm run db:test:notifications`, `npm run lint`, `npm run build`. The database integration test uses a disposable isolated schema and does not send email or modify public users.
