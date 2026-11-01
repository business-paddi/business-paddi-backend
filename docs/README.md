# Backend documentation

## Current frontend contracts

Bank dropdown: [Bank catalogue](handoffs/BANK_CATALOGUE_FRONTEND_HANDOFF.md) — public snapshot, queries, response examples, caching and maintenance.

| Feature                     | Start here                                                                          | Additional contracts                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Businesses and membership   | [Business API](handoffs/BUSINESS_FRONTEND_HANDOFF.md)                               | [Invites and approvals](handoffs/INVITE_EMAIL_AND_APPROVAL_HANDOFF.md)               |
| Employees and groups        | [Employee UI](handoffs/EMPLOYEE_UI_BACKEND_HANDOFF.md)                              | [Payment and tax profile](handoffs/EMPLOYEE_PAYMENT_TAX_PROFILE_FRONTEND_HANDOFF.md) |
| Policies                    | [Guided chat](handoffs/POLICY_CHAT_FRONTEND_HANDOFF.md)                             | [Policy forms and assignments](handoffs/SIMPLE_POLICY_FRONTEND_HANDOFF.md)           |
| Payroll                     | [Preparation API](handoffs/PAYROLL_PREPARATION_FRONTEND_HANDOFF.md)                 | [Response examples](handoffs/PAYROLL_RESPONSE_EXAMPLES.json)                         |
| Plans and referrals         | [Plans and referrals](handoffs/PLANS_REFERRALS_BACKEND_HANDOFF.md)                  | Checkout, payment webhooks and payouts remain pending integration                    |
| Inventory                   | [Inventory API](handoffs/INVENTORY_FRONTEND_HANDOFF.md)                             |                                                                                      |
| Tasks and public contact    | [Tasks and contact](handoffs/TASKS_DASHBOARD_CONTACT_FRONTEND_HANDOFF.md)           |                                                                                      |
| Notifications and auditing  | [Notifications and audit](handoffs/NOTIFICATIONS_AND_BUSINESS_AUDIT_HANDOFF.md)     |                                                                                      |
| Identity and authentication | [Email, authentication and invites](handoffs/EMAIL_AUTH_INVITE_FRONTEND_HANDOFF.md) |                                                                                      |

Policy AI is temporarily disabled. Follow the guided chat document for the form handoff. [AI inference notes](handoffs/POLICY_AI_FRONTEND_HANDOFF.md) preserve the implementation contract for a future rollout and are not the active frontend flow.

More specific feature handoffs take precedence over older general handoffs for the same field or workflow. Source DTOs and controller routes describe the implemented API.

## Other material

- [Dated backend review](reviews/BACKEND_REVIEW_2026_10_13.md): historical findings, not a current API contract.
- [Account email previews](previews/email-previews.html) and [invitation preview](previews/invite-email-preview.html): generated visual references.
- Regenerate previews with `npx ts-node --project tsconfig.scripts.json scripts/maintenance/render-email-previews.ts` from the repository root.
- Local imported reference source belongs in ignored `.inspection/`; it is excluded from TypeScript compilation.

## Provider integrations

- [Remita payroll feasibility](integrations/remita.md) and [local testing/API handoff](integrations/remita-local.md): instruction-only mock proof of concept; live payments disabled.
