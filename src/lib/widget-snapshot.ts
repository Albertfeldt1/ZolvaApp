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
