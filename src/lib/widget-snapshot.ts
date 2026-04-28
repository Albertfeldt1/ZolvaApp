// src/lib/widget-snapshot.ts
//
// JSON contract between the RN app (writer) and the iOS widget extension (reader).
// schema is bumped on any meaning change so old extensions reject new payloads
// (and vice versa) gracefully — both sides fall through to a placeholder.

export const WIDGET_SNAPSHOT_SCHEMA = 1;

export type SnapshotEvent = {
  id: string;
  start: string; // ISO 8601 with offset
  end: string;
  title: string;
};

export type SnapshotPayload = {
  schema: number;
  generatedAt: string; // ISO 8601 with offset
  morningBrief: { headline: string } | null;
  eveningBrief: { headline: string } | null;
  todayEvents: SnapshotEvent[];
  // Empty string falls back to default "Spørg Zolva..." copy on the widget side.
  chatPrompt: string;
};

export type BuildSnapshotInput = {
  now: Date;
  morningBrief: { headline: string } | null;
  eveningBrief: { headline: string } | null;
  events: Array<{ id: string; start: Date; end: Date; title: string }>;
};

const MAX_TODAY_EVENTS = 8;

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function buildSnapshotFromState(input: BuildSnapshotInput): SnapshotPayload {
  const today = input.events
    .filter((e) => isSameLocalDay(e.start, input.now))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_TODAY_EVENTS)
    .map((e) => ({
      id: e.id,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      title: e.title,
    }));
  return {
    schema: WIDGET_SNAPSHOT_SCHEMA,
    generatedAt: input.now.toISOString(),
    morningBrief: input.morningBrief,
    eveningBrief: input.eveningBrief,
    todayEvents: today,
    chatPrompt: '',
  };
}
