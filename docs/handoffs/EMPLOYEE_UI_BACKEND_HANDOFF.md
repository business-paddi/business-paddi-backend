# Employee UI backend implementation

All routes below use the existing `/api` prefix and cookie authentication. No role or permission grants have been added or changed.

## Persisted group appearance

- `POST /api/businesses/:businessId/groups`: `{name, description?, color?, icon?}`; requires `employee_lists:create`.
- `GET /api/businesses/:businessId/groups`: `{items:[group,...]}`; requires `employee_lists:view`.
- `GET /api/businesses/:businessId/groups/:groupId`: `{group}`; requires `employee_lists:view`.
- `PATCH /api/businesses/:businessId/groups/:groupId`: any nonempty subset of `{name, description, color, icon}`; requires `employee_lists:update`.

All group objects from these endpoints include `color` and `icon`, including existing groups. Both are nullable: `color:null` means white (`#FFFFFF`), and `icon:null` means Lucide `Users`. Persist nullable defaults as returned; frontend fallback is `color ?? '#FFFFFF'`, `icon ?? 'Users'`. Omitted PATCH fields preserve their current values. Explicit null resets appearance. A null/empty name is invalid; empty PATCH objects are invalid.

Example create:

```json
{ "name": "Engineering", "color": "#3456AB", "icon": "Code" }
```

`color` must match `#[0-9A-Fa-f]{6}`. `icon` must be exactly one of: Users, Briefcase, Code, Palette, Heart, ShoppingBag, Building, Shield, GraduationCap, Headphones, Wrench, Package. Invalid values return 400. Names may contain up to 100 characters and descriptions 2000. Duplicate group names return 409. Other-business/unknown group IDs return 404. Archived groups cannot be updated.

Group configuration events remain in the existing business audit stream. Appearance changes additionally record `business.employee_group.appearance_changed`, with actor, group ID, and before/after color/icon values, within the database transaction. Initial nondefault appearance is audited too; no-op appearance updates do not generate another appearance event.

Frontend can now remove preview-only wording and visit-only appearance state. Submit chosen values, use the persisted response, then invalidate the group list/detail and related member profile queries. Render icons via the bounded component mapping; never evaluate arbitrary icon names or SVG.

## Canonical employee lifecycle

These are **employee record** states, independent of `User.status` and `BusinessMember.status`:

| `status` | Indicator | Meaning |
| --- | --- | --- |
| `active` | Green | Active employee |
| `suspended`, `on_leave` | Amber | Existing nonactive employment states |
| `archived` | Yellow | Archived employee |
| `scheduled_for_deletion` | Red | A recoverable deletion is scheduled |
| `deleted` | Red | Soft-deleted employee record |

Do not use `pending_deletion` or `pending_delete` aliases in employee requests. Platform account deletion is a separate lifecycle and does not automatically mark every employee record deleted.

Both employee list and detail responses now include:

```json
{
  "status": "scheduled_for_deletion",
  "businessMemberId": null,
  "deletionScheduledAt": "2030-12-01T09:00:00.000Z",
  "deletionRequestedAt": "2030-11-25T10:00:00.000Z",
  "deletedAt": null
}
```

The example dates are illustrative. These values exist for employees without a platform account. Non-deletion states return null timestamps. Dates serialize as UTC instants; the client should display them in the user's timezone, with the timezone visible in the confirmation UI.

List filtering remains page-based. `GET /api/businesses/:businessId/employees?status=scheduled_for_deletion` or `?status=deleted` returns those records. Default listing excludes archived and deleted employees but includes pending deletion so its red badge is visible. Archived/deleted details remain accessible through their business-scoped detail endpoint with existing viewing permissions. Operational employee summary counts exclude archived/pending-deletion/deleted records.

## Lifecycle operations

Each endpoint returns `{employee, changed}`. Lifecycle response employee fields include the same public identity/status/timestamps as employee list/detail, without banking/compensation details. Normal employee editing still accepts only active/suspended/on_leave. Never submit deletion states through the ordinary employee PATCH.

| Method and employee route suffix | Body | Existing permissions |
| --- | --- | --- |
| PATCH `/:employeeId/schedule-deletion` | `{scheduledFor, reason?}` | `employees:archive` |
| PATCH `/:employeeId/cancel-deletion` | `{reason?}` | `employees:archive` |
| PATCH `/:employeeId/delete` | `{reason?}` | `employees:archive` |
| PATCH `/:employeeId/restore` | `{reason?}` | `employees:archive` and `employees:update` |

Full route base: `/api/businesses/:businessId/employees`. Send `{}` when no reason is supplied. `reason` is optional, up to 500 characters, and stored in the authorized business audit stream.

`scheduledFor` must be a real future ISO timestamp with seconds and an explicit timezone, for example `2030-12-01T10:00:00+01:00` or `2030-12-01T09:00:00Z`. The backend normalizes it to UTC. Date-only/local-time values are rejected to prevent timezone ambiguity. The schedule is durable in Postgres, rather than a browser timer.

Scheduling immediately marks the employee `scheduled_for_deletion`, blocks payment eligibility, and prevents normal employee/tax edits and new invite linking. Until the deadline, cancellation restores the prior status (active/suspended/on_leave/archived), but leaves payment blocked pending the normal verification process. The same schedule is idempotent; to change a deadline, cancel it first and schedule again.

At/after the deadline cancellation returns 409. A backend worker checks on startup and every minute, processes up to 20 due records per pass with database row locks, and retries failures on the next pass. The badge can remain scheduled while a due job is queued or the backend is offline. Restarts pick up due schedules. Multiple server instances skip already-locked rows.

`delete` performs immediate **soft deletion**, including for employees without accounts. Repeating it returns `changed:false`. Employee identity, group links, tax/banking records, policy records, and historical payroll/audit references remain intact; there is no hard-delete or automatic data-purge operation. No retention duration or legal destruction policy is implied by this feature.

`restore` returns a deleted employee to **archived**, clears deletion timestamps, and leaves payment blocked. It restores historical visibility, not active employment or payable status. Existing archived-employee editing restrictions remain; reactivation is outside these operations. Repeating restore on an already-archived record is harmless (`changed:false`). A deleted employee must be restored before a new deletion schedule can be created.

None of these operations changes or removes the linked BusinessMember/User, its role, or role grants. Use existing membership administration separately if platform access must change. This is deliberate: deleting an employee record is not deleting a platform account.

## Payroll and audit effects

Payment remains backend-derived. Scheduling/deleting/restoring never makes an employee payable. Existing payroll candidate selection requires active employees, and payroll calculation marks any other state ineligible. A changed status changes the payroll source version: draft/submitted payroll must refresh/review the source instead of silently using the prior employee state. Approved payroll snapshots and obligations remain preserved; these operations do not rewrite historical payroll.

Lifecycle operations record `business.employee.deletion_scheduled`, `business.employee.deletion_cancelled`, `business.employee.deleted`, or `business.employee.restored` with relevant status/timestamp changes. Explicit operations use the authenticated actor. Scheduled completion uses a system/null actor and preserves the original requester in metadata. Existing generic employee-update audit events also remain. Failed transactions roll back status and audit together.

## Frontend follow-up and acceptance

1. Send appearance fields during group creation, consume persisted values, remove the preview wording, and confirm colour/icon survive refresh/revisit.
2. Test invalid short/long/nonhex colours, unknown icons, empty updates and null appearance resets.
3. Verify group detail/update and employee lifecycle requests reject other-business IDs without changing data.
4. Use canonical red status mappings on employee list/detail, including `businessMemberId:null` records; keep deletion states out of ordinary status radio cards.
5. Surface lifecycle operations only when their existing permissions are present. Use explicit confirmation copy (“Delete employee record”, “Schedule deletion”), explaining record retention and independent account access.
6. Show the selected timezone and exact timestamp before scheduling. Refresh employee list/detail and summaries after lifecycle changes; poll a due schedule until it completes.
7. Test cancellation before/at the deadline, duplicate schedule/delete requests, restoration to archived, and historical payroll/audit visibility.
8. Existing employee drafts, payment clearing with null, complete-set `groupIds` updates, type/status/pay-frequency controls, avatar handling, and page-scoped search keep their existing contracts.

Schema migration: `20261019190000_employee_appearance_lifecycle`. Existing groups receive nullable appearance defaults; existing employee states do not change. No new permissions or role grants are introduced.
