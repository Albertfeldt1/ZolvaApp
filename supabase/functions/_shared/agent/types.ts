// supabase/functions/_shared/agent/types.ts

export type AgentEventKind =
  | 'mail.new'
  | 'mail.replied'
  | 'calendar.changed'
  | 'calendar.upcoming'
  | 'fact.created'
  | 'fact.due'
  | 'time.morning'
  | 'time.midday'
  | 'time.evening'
  | 'time.sweep'
  | 'user.idle'
  | 'user.intent';

export type AgentRunTrigger =
  | 'tick'
  | 'reflect.morning'
  | 'reflect.midday'
  | 'reflect.evening'
  | 'reflect.sweep';

export type ActionType =
  | 'mail.label'
  | 'mail.archive'
  | 'mail.flag_important'
  | 'mail.summarize'
  | 'mail.draft_reply'
  | 'mail.send_reply'
  | 'mail.send_new'
  | 'mail.get_body'
  | 'cal.list_events'
  | 'cal.rsvp'
  | 'cal.create_event'
  | 'cal.update_event'
  | 'cal.suggest_times'
  | 'brief.compose'
  | 'nudge.push'
  | 'memory.followup_draft'
  | 'standing_task.create';

export type PolicyMode = 'auto' | 'propose' | 'off';

// Narrower variant used by the dispatcher: a resolved per-tool decision
// can only be 'auto' (try to execute) or 'propose' (write a proposal).
// 'off' is handled earlier by the runner and never reaches dispatch.
export type ActionMode = 'auto' | 'propose';

export type AgentRunStatus = 'running' | 'ok' | 'error' | 'budget_exceeded';

export interface AgentEvent {
  id: number;
  user_id: string;
  kind: AgentEventKind;
  payload: Record<string, unknown>;
  created_at: string;
  processed_at: string | null;
  batch_id: string | null;
}

export interface UserPolicyRow {
  user_id: string;
  action_type: ActionType;
  mode: PolicyMode;
}

// Default policy table - keyed by ActionType. Anything not listed
// here is treated as 'off' by resolvePolicy. Mirrors spec §5.1.
export const DEFAULT_POLICY: Record<ActionType, PolicyMode> = {
  'mail.label': 'auto',
  'mail.archive': 'auto',
  'mail.flag_important': 'auto',
  'mail.summarize': 'auto',
  'mail.draft_reply': 'auto',
  'mail.send_reply': 'propose',
  'mail.send_new': 'propose',
  'mail.get_body': 'auto',
  'cal.list_events': 'auto',
  'cal.rsvp': 'propose',
  'cal.create_event': 'propose',
  'cal.update_event': 'propose',
  'cal.suggest_times': 'auto',
  'brief.compose': 'auto',
  'nudge.push': 'auto',
  'memory.followup_draft': 'auto',
  'standing_task.create': 'propose',
};

// Same shape as DEFAULT_POLICY but narrowed to the auto|propose pair the
// dispatcher receives after the runner filters out 'off'. Exported so
// callers that want to reason about default execution intent (without
// the 'off' case) can use it directly.
// KEEP IN SYNC WITH DEFAULT_POLICY above. ACTION_DEFAULT_MODE narrows to the
// two-state union for runner gates; DEFAULT_POLICY includes 'off' which is a
// user override, never a default. When changing a default, update both maps.
export const ACTION_DEFAULT_MODE: Record<ActionType, ActionMode> = {
  'mail.label': 'auto',
  'mail.archive': 'auto',
  'mail.flag_important': 'auto',
  'mail.summarize': 'auto',
  'mail.draft_reply': 'auto',
  'mail.send_reply': 'propose',
  'mail.send_new': 'propose',
  'mail.get_body': 'auto',
  'cal.list_events': 'auto',
  'cal.rsvp': 'propose',
  'cal.create_event': 'propose',
  'cal.update_event': 'propose',
  'cal.suggest_times': 'auto',
  'brief.compose': 'auto',
  'nudge.push': 'auto',
  'memory.followup_draft': 'auto',
  'standing_task.create': 'propose',
};
