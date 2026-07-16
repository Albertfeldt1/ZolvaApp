// Netværks-kontekst for daily-brief: match dagens kalender-deltagere/titler
// mod network_people, og log afholdte møder som network_interactions.
//
// VIGTIGT: Denne fil er bevidst IMPORT-FRI (ingen ./-imports, ingen esm.sh).
// Jest-testene i src/lib/__tests__/network-brief-match.test.ts importerer den
// direkte (babel-jest transpiler; app'ens tsc ignorerer supabase/ via
// tsconfig-exclude) — en import med .ts-suffix eller URL ville brække det.
// Typerne er derfor strukturelle dubletter: EventSummary (calendar.ts) er
// assignable til EventLite, og daily-brief mapper selv sine DB-rækker til
// PersonLite/FollowupLite.

export type AttendeeLite = {
  name: string | null;
  email: string | null;
};

export type EventLite = {
  title: string;
  startIso: string;
  endIso: string;
  allDay?: boolean;
  attendees?: AttendeeLite[];
};

export type PersonLite = {
  id: string;
  name: string;
  normalizedName: string;
  company: string | null;
  email: string | null;
};

export type FollowupLite = {
  personId: string;
  text: string;
  dueAtIso: string | null;
};

export type NetworkMeeting = {
  event: EventLite;
  person: PersonLite;
  lastInteractionSummary: string | null;
  openFollowupTexts: string[];
};

// Tro kopi af normalizeFactText (src/lib/profile-store.ts:39) — SKAL matche
// den normalisering klienten skrev network_people.normalized_name med:
// lowercase → NFKD → fjern tegnsætning/symboler → kollaps whitespace.
export function normalizeName(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ren matcher: hvilke af dagens events involverer personer fra netværket?
 * 1) attendee-email mod person.email (lowercase, eksakt),
 * 2) attendee-navn mod normalized_name,
 * 3) event-TITEL indeholder personens fulde navn — kun for personer med
 *    mindst to navne-tokens, med token-grænser ("Lars" alene må aldrig
 *    matche titlen "Larsens afskedsreception").
 * Dedup pr. (event, person) — en person kan optræde i flere events.
 */
export function matchEventsToPeople(
  events: EventLite[],
  people: PersonLite[],
): Array<{ event: EventLite; person: PersonLite }> {
  if (events.length === 0 || people.length === 0) return [];
  const byEmail = new Map<string, PersonLite>();
  const byName = new Map<string, PersonLite>();
  for (const p of people) {
    const email = p.email?.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, p);
    if (p.normalizedName && !byName.has(p.normalizedName)) byName.set(p.normalizedName, p);
  }
  const titleCandidates = people.filter((p) => p.normalizedName.split(' ').length >= 2);

  const out: Array<{ event: EventLite; person: PersonLite }> = [];
  for (const event of events) {
    const seen = new Set<string>();
    const add = (person: PersonLite) => {
      if (seen.has(person.id)) return;
      seen.add(person.id);
      out.push({ event, person });
    };
    for (const a of event.attendees ?? []) {
      const email = a.email?.trim().toLowerCase();
      const emailHit = email ? byEmail.get(email) : undefined;
      if (emailHit) {
        add(emailHit);
        continue;
      }
      const nameHit = a.name ? byName.get(normalizeName(a.name)) : undefined;
      if (nameHit) add(nameHit);
    }
    const paddedTitle = ` ${normalizeName(event.title)} `;
    for (const p of titleCandidates) {
      if (paddedTitle.includes(` ${p.normalizedName} `)) add(p);
    }
  }
  return out;
}

// Stabil dedup-nøgle for "dette møde er logget": lokal dato + normaliseret
// titel. startIso er provider-lokal (Google får timeZone-param, Graph leverer
// naiv lokal tid), så slice(0,10) er mødets lokale dato.
export function calendarSourceRef(event: EventLite): string {
  return `cal:${event.startIso.slice(0, 10)}:${normalizeName(event.title)}`;
}

// Strukturel klient-type: service-role-klienten i daily-brief opfylder den.
// RLS er omgået med service role, så HVER query skal selv .eq('user_id', …).
type DbClient = {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
};

export type NetworkContext = {
  people: PersonLite[];
  openFollowups: FollowupLite[];
};

const PEOPLE_CAP = 200;

export async function fetchNetworkContext(
  client: DbClient,
  userId: string,
): Promise<NetworkContext> {
  const [peopleRes, followupsRes] = await Promise.all([
    client
      .from('network_people')
      .select('id, name, normalized_name, company, email')
      .eq('user_id', userId)
      .eq('status', 'confirmed')
      .order('updated_at', { ascending: false })
      .limit(PEOPLE_CAP),
    client
      .from('network_followups')
      .select('person_id, text, due_at')
      .eq('user_id', userId)
      .is('done_at', null),
  ]);
  if (peopleRes.error) throw peopleRes.error;
  if (followupsRes.error) throw followupsRes.error;
  const people: PersonLite[] = (peopleRes.data ?? []).map(
    (r: Record<string, unknown>) => ({
      id: r.id as string,
      name: r.name as string,
      normalizedName: (r.normalized_name as string) ?? '',
      company: (r.company as string | null) ?? null,
      email: (r.email as string | null) ?? null,
    }),
  );
  const openFollowups: FollowupLite[] = (followupsRes.data ?? []).map(
    (r: Record<string, unknown>) => ({
      personId: r.person_id as string,
      text: r.text as string,
      dueAtIso: (r.due_at as string | null) ?? null,
    }),
  );
  return { people, openFollowups };
}

/** Seneste interaktions-summary pr. person ("I talte sidst om …"). */
export async function fetchLatestInteractionByPerson(
  client: DbClient,
  userId: string,
  personIds: string[],
): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  if (personIds.length === 0) return latest;
  const { data, error } = await client
    .from('network_interactions')
    .select('person_id, summary, occurred_at')
    .eq('user_id', userId)
    .in('person_id', personIds)
    .order('occurred_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const pid = r.person_id as string;
    if (!latest.has(pid)) latest.set(pid, r.summary as string);
  }
  return latest;
}

const SUMMARY_TITLE_MAX = 120;

/**
 * Log et afholdt møde som interaktion + bump last_contacted_at.
 * Idempotent: check-then-insert på source_ref (server-spejl af klientens
 * addInteraction-guard) — daily-brief kører op til tre gange om dagen.
 * Kalderen wrapper i try/catch: logning må aldrig vælte brief-generering.
 */
export async function logCalendarInteraction(
  client: DbClient,
  userId: string,
  meeting: { event: EventLite; person: PersonLite },
): Promise<void> {
  const sourceRef = calendarSourceRef(meeting.event);
  const existing = await client
    .from('network_interactions')
    .select('id')
    .eq('user_id', userId)
    .eq('person_id', meeting.person.id)
    .eq('source_ref', sourceRef)
    .limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length > 0) return;

  // Naiv Graph-ISO parses som UTC og driver occurred_at med tz-offsettet —
  // acceptabelt for en tidslinje (datoen er det bærende).
  const startMs = Date.parse(meeting.event.startIso);
  const occurredAt = Number.isFinite(startMs) ? new Date(startMs) : new Date();
  const title = meeting.event.title.slice(0, SUMMARY_TITLE_MAX);
  const inserted = await client.from('network_interactions').insert({
    user_id: userId,
    person_id: meeting.person.id,
    kind: 'calendar',
    summary: `Møde: ${title}`,
    occurred_at: occurredAt.toISOString(),
    source_ref: sourceRef,
  });
  if (inserted.error) throw inserted.error;

  // Regression-guard: et gammelt møde der logges sent må ikke rulle en
  // nyere last_contacted_at tilbage.
  const iso = occurredAt.toISOString();
  const bumped = await client
    .from('network_people')
    .update({ last_contacted_at: iso })
    .eq('user_id', userId)
    .eq('id', meeting.person.id)
    .or(`last_contacted_at.is.null,last_contacted_at.lt.${iso}`);
  if (bumped.error) throw bumped.error;
}
