# Backend review — 13 October 2026

Reviewed the pending inventory/sales, invitation delivery and approval, branded email, notification/audit, task/contact and employee payment/tax-profile changes. Checked tenant boundaries, effective permissions, transactional writes, retry/idempotency behavior, private image access and migration safeguards.

## Corrections

- Employee updates now invalidate verification metadata when a manually supplied account holder name replaces the stored value. A name supplied by a user must not retain a provider verification result for the previous name. Unchanged encrypted values remain stable.
- Task image cleanup rechecks expiry inside its locked transaction. An expired upload intent selected before concurrent finalization must not be deleted after finalization extends its expiry. The database integration test reproduces this ordering and asserts the provider delete is never called.
- Removed a duplicate shutdown-hook registration.

## Operational considerations

- Task analytics currently loads assignment/attempt history for the authorized scope into memory. Move aggregation into PostgreSQL and profile dashboard queries as business history grows; pagination currently limits response size, not all work performed.
- Submitted task images, contact requests and business audit/history records currently have no automatic retention limit. Define retention and deletion policies before large-scale use. Draft image cleanup is implemented.
- Private task evidence needs all Cloudinary credentials and a production HTTPS `TASK_PUBLIC_API_URL`. Payroll encryption keys and invite payload encryption secrets must remain stable across replicas and deployments.
- Invitation retries depend on Resend's idempotency contract. Delivery becomes uncertain instead of retrying beyond its safe deduplication window. This avoids claiming that a database transaction alone can guarantee exactly-once delivery to an external provider.
- Integration checks use isolated database schemas and fake email/image providers; they do not exercise live provider delivery or credentials.

See the feature-specific frontend handoff files for request/response contracts and configuration.
