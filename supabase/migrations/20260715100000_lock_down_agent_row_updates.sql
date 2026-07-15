-- Sikkerhedsgennemgang 2026-07-02 (finding: klient-UPDATE uden kolonne-værn).
-- proposed_actions og trust_offers kunne begge opdateres bredt af den
-- indloggede bruger. Her strammes de to overflader.

-- 1) proposed_actions: klienten laver KUN select (realtime-feed). Godkend og
--    afvis går via edge functions (agent-approve/agent-dismiss) med
--    service_role, som omgår RLS. Den direkte UPDATE-policy var derfor både
--    unødvendig og farlig (bruger kunne sætte status='executed' uden om
--    runner-logikken). Fjern policyen og revoke grant som ekstra spærre.
drop policy if exists "owner-update-proposed-actions" on public.proposed_actions;
revoke update on public.proposed_actions from authenticated;

-- 2) trust_offers: klienten SKAL kunne flytte status (accepter/afvis pending,
--    revert accepted) plus tidsstemplerne — men aldrig approval_count,
--    payload-lignende felter, recipient eller action_type. Kolonne-grants er
--    den præcise mekanisme; RLS-policyen bevares til række-filtrering.
revoke update on public.trust_offers from authenticated;
grant update (status, decided_at, reverted_at) on public.trust_offers to authenticated;
