# auth.users FK cascade audit (2026-05-03)

Audit run before any real `purge_tenant_data` invocation, to confirm
no orphaned rows would survive a tenant deletion.

## Result

24 foreign keys reference `auth.users` from `public`. 22 cascade,
2 set-null. No FK is `NO ACTION` / `RESTRICT`, so account deletion
will not be blocked by referential integrity.

### CASCADE (clean wipe)

`backfill_jobs`, `briefs`, `chat_messages`, `facts`,
`icloud_calendar_creds_audit`, `icloud_credential_bindings`,
`icloud_proxy_calls`, `mail_events`, `mail_watchers`, `notes`,
`observations`, `profiles`, `push_subscriptions`, `push_tokens`,
`rate_limits`, `reminders`, `user_calendar_preferences`,
`user_email_domains`, `user_icloud_calendar_creds`,
`user_oauth_tokens`, `user_profiles`, `work_preferences`.

### SET NULL (rows persist with NULL user_id)

- `consent_events.user_id`
- `consented_tenants.granting_user_id`

These are intentional: consent grants are an audit trail and the
record needs to survive account deletion for legal/regulatory
reasons. The granter is anonymized but the event persists.

## Open product question (not a bug)

If `purge_tenant_data` is ever interpreted as "wipe every trace
of this user," the two SET NULL paths leak the existence of a
prior consent. If interpreted as "delete the account, retain
audit," current behavior is correct. Today's `tenant_deletion_log`
is empty, so this has never bitten and isn't blocking anything.

Decide before the first real purge run.

## How the audit was generated

Query against `pg_catalog.pg_constraint` filtered to
`contype = 'f'` and `confrelid = auth.users`, excluding
Supabase-internal schemas. Re-run via `supabase db query --linked`
if the schema changes.
