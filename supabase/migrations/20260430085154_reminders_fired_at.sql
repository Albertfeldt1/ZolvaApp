ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS fired_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_for_tz text;

CREATE INDEX IF NOT EXISTS reminders_due_unfired
  ON public.reminders (due_at)
  WHERE fired_at IS NULL AND completed = false;

CREATE INDEX IF NOT EXISTS reminders_user_pending
  ON public.reminders (user_id, due_at)
  WHERE completed = false;

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own reminders" ON public.reminders;

CREATE POLICY "reminders_self_read"
  ON public.reminders FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "reminders_self_insert"
  ON public.reminders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reminders_self_update"
  ON public.reminders FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "reminders_self_delete"
  ON public.reminders FOR DELETE
  USING (auth.uid() = user_id);

COMMENT ON COLUMN public.reminders.fired_at IS
  'Timestamp the reminders-fire cron sent the push notification. NULL means not yet fired. Used to dedupe across cron ticks.';

COMMENT ON COLUMN public.reminders.scheduled_for_tz IS
  'IANA timezone the user intended at create-time (e.g. "Europe/Copenhagen"). Lets the client render due_at in the original tz even if the user has since moved. Optional — falls back to user_settings.timezone.';
