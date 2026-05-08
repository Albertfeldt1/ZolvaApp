-- chat_jobs - background-execution rows for chat turns. Lets a turn keep
-- running on the server after the client backgrounds, so the user can leave
-- the app mid-question and come back to (or be pushed) the answer.
--
-- Pass 1 covers no-tool turns end-to-end: the chat-run edge function inserts
-- the row, calls Claude, writes outcome, sends an Expo push if the user has
-- a registered push token, and returns the body to any still-connected
-- client. Tool turns short-circuit to status='needs_tools' with the model's
-- first-round tool_use blocks attached so the client can pick up where the
-- server left off (today's local tool loop). Pass 2 ports tool execution
-- server-side and the needs_tools branch goes away.

CREATE TABLE public.chat_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status          text        NOT NULL CHECK (status IN ('running', 'done', 'needs_tools', 'error')),

  -- inbound
  input_messages  jsonb       NOT NULL,
  system_prompt   jsonb       NOT NULL,
  tools           jsonb,
  metadata        jsonb,

  -- outcome
  output_text     text,
  tool_uses       jsonb,
  error_code      text,

  -- lifecycle
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  -- delivery (set by client when it has displayed the answer in-band, so the
  -- foreground reconciler can skip jobs already shown in the live UI).
  acknowledged_at timestamptz
);

CREATE INDEX chat_jobs_user_created
  ON public.chat_jobs (user_id, created_at DESC);

-- Fast lookup for "what should I show on resume?" - jobs the client never
-- got to acknowledge in-band before backgrounding.
CREATE INDEX chat_jobs_user_unacked
  ON public.chat_jobs (user_id, finished_at DESC)
  WHERE status = 'done' AND acknowledged_at IS NULL;

ALTER TABLE public.chat_jobs ENABLE ROW LEVEL SECURITY;

-- Users can read and acknowledge their own jobs. Inserts and outcome writes
-- are service-role only (only the chat-run edge function should be writing
-- input/output bodies; letting clients craft input would bypass the server's
-- system prompt and tool whitelist).
CREATE POLICY "users read own chat jobs"
  ON public.chat_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "users acknowledge own chat jobs"
  ON public.chat_jobs FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Retention: 14 days is enough for "I tapped the notification 3 days later"
-- and short enough to keep the table from growing unbounded. Aligns with
-- existing icloud_proxy_calls (30d) and chat_messages (untouched - that's
-- the durable history table; chat_jobs is just the execution scaffold).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat-jobs-sweep') THEN
    PERFORM cron.unschedule('chat-jobs-sweep');
  END IF;
END
$$;

SELECT cron.schedule(
  'chat-jobs-sweep',
  '0 5 * * *',
  $$
  DELETE FROM public.chat_jobs
    WHERE created_at < now() - interval '14 days';
  $$
);
