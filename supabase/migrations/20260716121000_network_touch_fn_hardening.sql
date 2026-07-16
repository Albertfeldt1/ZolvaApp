-- Hardening af updated_at-triggeren fra network_module: SECURITY DEFINER er
-- unoedvendigt for en trigger (den koerer i tabellens kontekst), og definer-
-- funktioner i public-skemaet kan kaldes via /rest/v1/rpc af anon og
-- authenticated (advisor 0028/0029). Skift til invoker og fjern execute.
create or replace function public.touch_network_people_updated_at()
returns trigger
language plpgsql
security invoker set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.touch_network_people_updated_at() from public, anon, authenticated;
