-- supabase/migrations/20260530150000_trust_offers.sql
--
-- Trust-escalation v1: track per-(user, action_type, recipient) approvals
-- and surface a one-tap offer to auto-promote in the Today feed. See spec
-- 2026-05-11-autonomous-background-actions §5.3 + §6.4.

create table if not exists public.trust_offers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  action_type    text not null,
  recipient      text not null,
  status         text not null check (status in ('pending','accepted','dismissed','reverted')),
  approval_count int not null,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  reverted_at    timestamptz
);

-- Active offer = pending OR accepted. Both occupy the slot so we don't
-- double-prompt or stack two competing promotions for the same recipient.
create unique index if not exists trust_offers_active_uniq
  on public.trust_offers (user_id, action_type, recipient)
  where status in ('pending','accepted');

create index if not exists trust_offers_user_status_idx
  on public.trust_offers (user_id, status, created_at desc);

alter table public.trust_offers enable row level security;

-- Users read their own offers (Today feed + Settings).
create policy "owner-select-trust-offers" on public.trust_offers
  for select to authenticated
  using (auth.uid() = user_id);

-- Users update their own offers (decide pending, revert accepted). The
-- check clause prevents flipping someone else's row.
create policy "owner-update-trust-offers" on public.trust_offers
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Inserts are service-role-only (agent-approve writes pending rows). No
-- INSERT policy -> default-deny for authenticated.
