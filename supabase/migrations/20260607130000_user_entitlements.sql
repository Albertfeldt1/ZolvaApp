-- supabase/migrations/20260607130000_user_entitlements.sql
--
-- Billing foundation: server-side source of truth for a user's tier.
-- Synced from RevenueCat via the revenuecat-webhook edge function.
-- Absence of a row = 'free' baseline (no migration/backfill needed).
-- See spec 2026-06-07-billing-foundation-design.

create table if not exists public.user_entitlements (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  tier                text not null default 'free' check (tier in ('free','lite','pro')),
  is_trial            boolean not null default false,
  current_period_end  timestamptz,
  store               text,
  product_id          text,
  rc_app_user_id      text,
  updated_at          timestamptz not null default now(),
  raw_event           jsonb
);

alter table public.user_entitlements enable row level security;

-- Users read their own entitlement (drives client UI fallback / Settings).
create policy "owner-select-entitlement" on public.user_entitlements
  for select to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE policy for authenticated -> writes are service-role only
-- (the webhook function). Clients never write entitlements.
