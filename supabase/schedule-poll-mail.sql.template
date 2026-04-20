-- Paste this whole file into the Supabase Dashboard SQL editor.
-- Replace PASTE_SERVICE_ROLE_KEY with the raw service_role key from
--   Project Settings -> API, and PASTE_CRON_SHARED_SECRET with the value
--   you also set as `CRON_SHARED_SECRET` in Edge Function secrets.
-- Do NOT keep the angle brackets.

select cron.schedule(
  'poll-mail-every-min',
  '* * * * *',
  $cmd$select net.http_post(
    url:='https://sjkhfkatmeqtsrysixop.functions.supabase.co/poll-mail',
    headers:=jsonb_build_object(
      'Authorization','Bearer PASTE_SERVICE_ROLE_KEY',
      'Content-Type','application/json',
      'x-cron-secret','PASTE_CRON_SHARED_SECRET'
    )
  ) as request_id;$cmd$
);
