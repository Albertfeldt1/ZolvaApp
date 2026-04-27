-- The cron.schedule() call for the fact-decay-warning edge function lives in
-- schedule-fact-decay-warning.sql.template so its service-role bearer token
-- isn't committed to the repo. Apply it via the Supabase Dashboard SQL
-- editor after the fact-decay-warning function has been deployed.
--
-- Same pattern used by:
--   schedule-daily-brief.sql.template
--   schedule-poll-mail.sql.template

-- (intentionally empty — schedule lives in the .sql.template)
