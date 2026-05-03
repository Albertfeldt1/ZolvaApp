alter table public.integrations
  add column if not exists tenant_id text;

create index if not exists integrations_tenant_id_idx
  on public.integrations (tenant_id)
  where tenant_id is not null;
