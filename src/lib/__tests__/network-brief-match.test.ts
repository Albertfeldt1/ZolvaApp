// src/lib/__tests__/network-brief-match.test.ts
// Matcher-logikken bag briefens "Personer i dag" og møde-logningen. Filen
// under supabase/functions/_shared er bevidst import-fri, netop så den kan
// jest-importeres direkte her (app-tsc ignorerer supabase/ via exclude).
import {
  calendarSourceRef,
  matchEventsToPeople,
  normalizeName,
  type EventLite,
  type PersonLite,
} from '../../../supabase/functions/_shared/network-context';

const person = (over: Partial<PersonLite> & { name: string }): PersonLite => ({
  id: over.name,
  normalizedName: normalizeName(over.name),
  company: null,
  email: null,
  ...over,
});

const event = (over: Partial<EventLite> & { title: string }): EventLite => ({
  startIso: '2026-07-16T10:00:00+02:00',
  endIso: '2026-07-16T11:00:00+02:00',
  ...over,
});

describe('matchEventsToPeople', () => {
  const mette = person({ id: 'm', name: 'Mette Halling', company: 'Lunar', email: 'mette@lunar.app' });
  const lars = person({ id: 'l', name: 'Lars Jensen' });

  it('matcher på attendee-email uanset visningsnavn', () => {
    const e = event({
      title: 'Q3-status',
      attendees: [{ name: 'M. Halling', email: 'METTE@lunar.app' }],
    });
    expect(matchEventsToPeople([e], [mette, lars])).toEqual([{ event: e, person: mette }]);
  });

  it('matcher på attendee-navn når email ikke kendes', () => {
    const e = event({
      title: 'Workshop',
      attendees: [{ name: 'Mette Halling', email: null }],
    });
    expect(matchEventsToPeople([e], [mette])).toEqual([{ event: e, person: mette }]);
  });

  it('titel-match kræver fulde navn med token-grænser', () => {
    const hit = event({ title: 'Møde med Lars Jensen om AI' });
    const partial = event({ title: 'Frokost med Lars' });
    const substring = event({ title: 'Larsens afskedsreception' });
    expect(matchEventsToPeople([hit], [lars])).toHaveLength(1);
    expect(matchEventsToPeople([partial], [lars])).toHaveLength(0);
    expect(matchEventsToPeople([substring], [lars])).toHaveLength(0);
  });

  it('titel-match springer personer med ét navne-token over', () => {
    const kasper = person({ name: 'Kasper' });
    expect(matchEventsToPeople([event({ title: 'Kaffe med Kasper' })], [kasper])).toHaveLength(0);
  });

  it('normaliserer danske tegn og tegnsætning i titler', () => {
    const soren = person({ name: 'Søren Kjær' });
    const e = event({ title: '1:1 — SØREN KJÆR (opfølgning)' });
    expect(matchEventsToPeople([e], [soren])).toHaveLength(1);
  });

  it('dedupper pr. (event, person) når både email og titel rammer', () => {
    const e = event({
      title: 'Møde med Mette Halling',
      attendees: [{ name: null, email: 'mette@lunar.app' }],
    });
    expect(matchEventsToPeople([e], [mette])).toHaveLength(1);
  });

  it('samme person kan matche flere events', () => {
    const a = event({ title: 'Morgenmøde', attendees: [{ name: null, email: 'mette@lunar.app' }] });
    const b = event({ title: 'Opsamling med Mette Halling' });
    expect(matchEventsToPeople([a, b], [mette])).toHaveLength(2);
  });
});

describe('calendarSourceRef', () => {
  it('bygger stabil nøgle af lokal dato + normaliseret titel', () => {
    expect(
      calendarSourceRef(event({ title: 'Q3-møde: Lunar!', startIso: '2026-07-16T10:00:00+02:00' })),
    ).toBe('cal:2026-07-16:q3 møde lunar');
  });

  it('er identisk på tværs af gentagne kørsler samme dag', () => {
    const a = event({ title: 'Stand-up' });
    const b = event({ title: 'Stand-up', endIso: '2026-07-16T10:30:00+02:00' });
    expect(calendarSourceRef(a)).toBe(calendarSourceRef(b));
  });
});
