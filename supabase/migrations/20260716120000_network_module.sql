-- Netvaerk: AI-hukommelse for mennesker og relationer. network_people er
-- kernen; network_followups og network_interactions er generiske nok til at
-- mail/kalender kan koble paa senere (kind + source_ref) uden ny migration.
-- Identitet ("er det samme Lars?") afgoeres af ekstraktoren mod en roster af
-- eksisterende personer - derfor INGEN unique paa (user_id, normalized_name):
-- to forskellige "Lars Jensen" skal kunne eksistere side om side.

create table public.network_people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  normalized_name text not null,
  company text,
  normalized_company text,
  role text,
  relation text,
  industry text,
  how_we_met text,
  location text,
  email text,
  phone text,
  linkedin text,
  -- Fysiske kendetegn: gemmes KUN naar brugeren selv har naevnt dem.
  traits jsonb not null default '[]'::jsonb,
  interests jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  notes text,
  -- AI'ens een-linjes "hvem er det her"-opsummering (liste + chat-roster).
  summary text,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed')),
  met_through_person_id uuid references public.network_people(id) on delete set null,
  -- Feltnavne brugeren selv har redigeret; AI-merge maa aldrig overskrive dem.
  user_edited_fields jsonb not null default '[]'::jsonb,
  source text,
  last_contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index network_people_user_idx
  on public.network_people (user_id, updated_at desc);
create index network_people_identity_idx
  on public.network_people (user_id, normalized_name);

create table public.network_followups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.network_people(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 500),
  -- NULL = udateret loefte ("efter sommerferien" uden konkret dato).
  due_at timestamptz,
  done_at timestamptz,
  source text,
  created_at timestamptz not null default now()
);

create index network_followups_user_idx
  on public.network_followups (user_id, done_at, due_at);

create table public.network_interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.network_people(id) on delete cascade,
  kind text not null check (kind in ('chat', 'voice', 'note', 'meeting', 'mail', 'calendar', 'manual')),
  summary text not null check (char_length(summary) between 1 and 1000),
  occurred_at timestamptz not null default now(),
  -- Koblingspunkt for M2: 'chat:<msgId>' nu, 'google:<mailId>' o.l. senere.
  source_ref text,
  created_at timestamptz not null default now()
);

create index network_interactions_person_idx
  on public.network_interactions (user_id, person_id, occurred_at desc);

-- updated_at vedligeholdes i databasen saa klient-merges ikke kan glemme den.
create or replace function public.touch_network_people_updated_at()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger network_people_touch
  before update on public.network_people
  for each row execute function public.touch_network_people_updated_at();

alter table public.network_people enable row level security;
alter table public.network_followups enable row level security;
alter table public.network_interactions enable row level security;

create policy network_people_own on public.network_people
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy network_followups_own on public.network_followups
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy network_interactions_own on public.network_interactions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
