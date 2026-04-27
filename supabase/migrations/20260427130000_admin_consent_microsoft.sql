-- Microsoft tenant admin consent schema.
--
-- Enterprise / government Microsoft 365 tenants (Folketinget, kommuner,
-- regions, large companies) require admin consent before end-users can
-- grant Mail.Read / Calendar scopes. This migration adds:
--
--   1. consented_tenants    — one row per tenant whose admin granted consent
--   2. consent_events       — append-only telemetry of every step of the flow
--   3. tenant_id_cache      — domain → tenant_id from OIDC discovery
--   4. user_email_domains   — per-user email domain capture (independent of
--                             admin-consent; tells us how many users come
--                             from enterprise domains so we can size the
--                             feature's actual reach).
--
-- All four tables default to service-role-only via empty RLS. user_email_domains
-- has owner-write/read policies so the client can insert its own row after
-- sign-in.

-- ---------------------------------------------------------------------------
-- consented_tenants

create table if not exists public.consented_tenants (
  tenant_id text primary key,
  tenant_domain text not null,
  consented_at timestamptz not null default now(),
  consented_by_admin_email text,
  granting_user_id uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists consented_tenants_domain_idx
  on public.consented_tenants (tenant_domain);

alter table public.consented_tenants enable row level security;
-- No policies → service role only.

create or replace function public.consented_tenants_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists consented_tenants_updated_at on public.consented_tenants;
create trigger consented_tenants_updated_at
  before update on public.consented_tenants
  for each row execute function public.consented_tenants_set_updated_at();

-- ---------------------------------------------------------------------------
-- consent_events

create table if not exists public.consent_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  event_type text not null check (event_type in (
    'user_blocked',            -- client detected admin-consent-required, showed the screen
    'admin_link_generated',    -- microsoft-admin-consent-link issued a signed URL
    'admin_callback_received', -- Microsoft redirected to our callback (any outcome)
    'admin_consent_granted',   -- callback succeeded, consented_tenants row written
    'admin_consent_failed',    -- callback received error from Microsoft (or upstream)
    'state_invalid',           -- HMAC verification failed (or expired)
    'tenant_lookup',           -- OIDC discovery resolved a tenant_id
    'tenant_lookup_failed'     -- OIDC discovery failed
  )),
  tenant_id text,
  tenant_domain text,
  user_id uuid references auth.users (id) on delete set null,
  error_code text,
  error_description text,
  details jsonb
);

create index if not exists consent_events_occurred_idx
  on public.consent_events (occurred_at desc);
create index if not exists consent_events_tenant_idx
  on public.consent_events (tenant_id);
create index if not exists consent_events_user_idx
  on public.consent_events (user_id);
create index if not exists consent_events_type_idx
  on public.consent_events (event_type);

alter table public.consent_events enable row level security;
-- No policies → service role only.

-- ---------------------------------------------------------------------------
-- tenant_id_cache

create table if not exists public.tenant_id_cache (
  domain text primary key,
  tenant_id text not null,
  cached_at timestamptz not null default now()
);

alter table public.tenant_id_cache enable row level security;
-- No policies → service role only.

-- ---------------------------------------------------------------------------
-- user_email_domains
--
-- Independent of consent; populated from the client right after sign-in.
-- Tells us at a glance whether real users come from enterprise domains
-- and which ones — i.e., whether building admin consent is solving a real
-- problem at scale or just for one tenant.

create table if not exists public.user_email_domains (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email_domain text not null,
  first_seen_at timestamptz not null default now()
);

create index if not exists user_email_domains_domain_idx
  on public.user_email_domains (email_domain);

alter table public.user_email_domains enable row level security;

drop policy if exists "user_email_domains: owner can read" on public.user_email_domains;
create policy "user_email_domains: owner can read"
  on public.user_email_domains for select
  using (auth.uid() = user_id);

drop policy if exists "user_email_domains: owner can insert" on public.user_email_domains;
create policy "user_email_domains: owner can insert"
  on public.user_email_domains for insert
  with check (auth.uid() = user_id);
