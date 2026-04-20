-- Paste this whole file into the Supabase Dashboard SQL editor.
-- Replace PASTE_SERVICE_ROLE_KEY with the raw key from Project Settings -> API.
-- Do NOT keep the angle brackets.

select cron.schedule(
  'poll-mail-every-min',
  '* * * * *',
  $cmd$select net.http_post(url:='https://sjkhfkatmeqtsrysixop.functions.supabase.co/poll-mail',headers:=jsonb_build_object('Authorization','Bearer PASTE_SERVICE_ROLE_KEY','Content-Type','application/json')) as request_id;$cmd$
);
