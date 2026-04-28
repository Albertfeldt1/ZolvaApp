import {
  WIDGET_SNAPSHOT_SCHEMA,
  buildSnapshotFromState,
} from '../widget-snapshot';

const REF_NOW = new Date('2026-04-27T08:00:00+02:00');

describe('buildSnapshotFromState', () => {
  it('emits schema + generatedAt set to now()', () => {
    const out = buildSnapshotFromState({
      now: REF_NOW,
      morningBrief: null,
      eveningBrief: null,
      events: [],
    });
    expect(out.schema).toBe(WIDGET_SNAPSHOT_SCHEMA);
    expect(out.generatedAt).toBe('2026-04-27T06:00:00.000Z');
  });

  it('preserves both briefs when present', () => {
    const out = buildSnapshotFromState({
      now: REF_NOW,
      morningBrief: { headline: 'Tre møder, ét fokuspunkt.' },
      eveningBrief: { headline: 'Du klarede det.' },
      events: [],
    });
    expect(out.morningBrief).toEqual({ headline: 'Tre møder, ét fokuspunkt.' });
    expect(out.eveningBrief).toEqual({ headline: 'Du klarede det.' });
  });

  it('keeps only events whose start is today (local), sorted by start', () => {
    const out = buildSnapshotFromState({
      now: REF_NOW,
      morningBrief: null,
      eveningBrief: null,
      events: [
        { id: 'b', start: new Date('2026-04-27T14:00:00+02:00'), end: new Date('2026-04-27T15:00:00+02:00'), title: 'Late' },
        { id: 'past', start: new Date('2026-04-26T20:00:00+02:00'), end: new Date('2026-04-26T21:00:00+02:00'), title: 'Yesterday' },
        { id: 'a', start: new Date('2026-04-27T09:00:00+02:00'), end: new Date('2026-04-27T10:00:00+02:00'), title: 'Early' },
        { id: 'tomorrow', start: new Date('2026-04-28T09:00:00+02:00'), end: new Date('2026-04-28T10:00:00+02:00'), title: 'Tomorrow' },
      ],
    });
    expect(out.todayEvents.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out.todayEvents[0].start).toBe('2026-04-27T07:00:00.000Z');
  });

  it('caps todayEvents at 8 (widget never renders more than that)', () => {
    const events = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      start: new Date(`2026-04-27T${String(8 + i).padStart(2, '0')}:00:00+02:00`),
      end: new Date(`2026-04-27T${String(9 + i).padStart(2, '0')}:00:00+02:00`),
      title: `E${i}`,
    }));
    const out = buildSnapshotFromState({
      now: REF_NOW,
      morningBrief: null,
      eveningBrief: null,
      events,
    });
    expect(out.todayEvents).toHaveLength(8);
  });

  it('defaults chatPrompt to empty string', () => {
    const out = buildSnapshotFromState({
      now: REF_NOW,
      morningBrief: null,
      eveningBrief: null,
      events: [],
    });
    expect(out.chatPrompt).toBe('');
  });
});
