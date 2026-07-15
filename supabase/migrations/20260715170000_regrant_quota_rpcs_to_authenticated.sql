-- HOTFIX: 20260715090000 revokede authenticated-EXECUTE på alle 13 SECURITY
-- DEFINER-funktioner ud fra antagelsen at edge functions kalder dem med
-- service_role. Det gjaldt IKKE kvote-funktionerne: claude-proxy, chat-run,
-- tts-proxy og transcribe-proxy kalder dem via en anon-key-klient med
-- brugerens JWT (authenticated) - så hele AI-stakken svarede 500 fra ca.
-- kl. 09 til denne migration.
--
-- Kun de fire kvote-/usage-funktioner genåbnes. purge_tenant_data, agent_*,
-- *_mail_watcher_lock, handle_new_user m.fl. forbliver service_role-only.
--
-- Kendt rest-risiko (fandtes også før lockdown): funktionerne tager
-- p_user_id som parameter og validerer ikke mod auth.uid(), så en klient kan
-- tælle på en anden brugers kvote. Opfølgning: tilføj auth.uid()-guard i
-- funktionskroppene og revoke igen, eller flyt kaldene til service-klienten.

grant execute on function public.check_and_incr_claude_usage(uuid, integer, integer) to authenticated;
grant execute on function public.check_and_incr_chat_quota(uuid, integer) to authenticated;
grant execute on function public.record_claude_tokens(uuid, integer, integer) to authenticated;
grant execute on function public.record_ai_usage(uuid, text, text, integer, integer) to authenticated;
