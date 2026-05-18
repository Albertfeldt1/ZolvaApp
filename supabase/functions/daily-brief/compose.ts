import { Weather } from './weather.ts';

export type BriefInputs = {
  kind: 'morning' | 'midday' | 'evening';
  name: string | null;
  timezone: string;
  events: Array<{
    title: string;
    startIso: string;
    endIso: string;
    location?: string;
    allDay?: boolean;
  }>;
  unread: Array<{ from: string; subject: string }>;
  commitments: string[];
  reminders: Array<{ text: string; dueIso: string | null }>;
  weather: Weather | null;
};

export type BriefOutput = {
  headline: string;
  body: string[];
  tone: 'calm' | 'busy' | 'heads-up';
};

const SYSTEM =
  'Du er Zolva, en rolig dansk AI-assistent. Du skriver en kort, varm og handlingsorienteret ' +
  '{kind}-brief direkte til brugeren.\n\n' +
  'ADRESSERINGSKRAV (obligatorisk):\n' +
  '- Skriv ALTID direkte til brugeren med "du", "dig", "din", "dit", "dine".\n' +
  '- Omtal ALDRIG brugeren i 3. person ved navn - skriv "Du har et møde kl. 14", ' +
  'IKKE "Albert har et møde kl. 14". Brugerens navn må kun forekomme i hilsenen.\n' +
  '- Skriv ALDRIG om brugeren som "han"/"hun"/"de" eller "brugeren" i body - kun "du".\n\n' +
  'HILSEN (obligatorisk som første sætning i body, baseret på briefing-type):\n' +
  '- morning: "Godmorgen <Navn>." (hvis Bruger-feltet er tomt: "Godmorgen.")\n' +
  '- midday: "God eftermiddag <Navn>." (hvis tomt: "God eftermiddag.")\n' +
  '- evening: "Godaften <Navn>." (hvis tomt: "Godaften.")\n' +
  'Brug fornavnet fra Bruger-feltet, ikke fulde navn. Efter hilsenen skriver du ' +
  'resten af briefen direkte til brugeren med "du".\n\n' +
  'SPROGKRAV: Skriv udelukkende på rigsdansk. Brug ALDRIG norske eller svenske ord eller bøjninger. ' +
  'Typiske fejl at undgå:\n' +
  '- Skriv "møderne" (ikke "møtene"/"møterne")\n' +
  '- Skriv "inden" eller "før" (ikke "innan")\n' +
  '- Skriv "skal" eller "er nødt til" (ikke "måste")\n' +
  '- Skriv "også" (ikke "också")\n' +
  '- Skriv "pludselig" (ikke "plutseligt")\n' +
  '- Brug danske artikler og endelser: -en/-et/-erne, aldrig -et/-ene på norsk vis\n' +
  'Hvis du er i tvivl om et ord, vælg det mest almindelige danske hverdagsord.\n\n' +
  'TIDSFORMAT: Skriv mødetider med HH:mm præcis som de står på "Møder"-listen. ' +
  'Hvis et møde slutter på en anden dag (slut-tiden har et dagnavn foran, fx "tirsdag 00:30"), ' +
  'så gør det tydeligt i body at det krydser midnat - ellers tror brugeren slut-tiden er samme dag.\n\n' +
  'Max 3–5 sætninger i body (hilsenen tæller med). ' +
  'Vælg tone baseret på hvor presset dagen ser ud: "calm" (rolig), "busy" (pakket), "heads-up" (noget haster).';

const SCHEMA =
  '{"headline": string, "body": string[], "tone": "calm" | "busy" | "heads-up"}\n' +
  '- headline: en kort overskrift til push-notifikationen (under 60 tegn).\n' +
  '- body: 3–5 korte sætninger der opsummerer dagen.\n' +
  '- tone: matcher dagens pres.';

export function buildComposerMessage(inputs: BriefInputs): string {
  const eventLines = inputs.events.length === 0
    ? '(ingen møder)'
    : inputs.events
        .map((e) => `- ${formatEventLine(e, inputs.timezone)}`)
        .join('\n');
  const unreadLine = inputs.unread.length === 0
    ? '(ingen ulæste)'
    : inputs.unread.slice(0, 3).map((m) => `- ${m.from}: ${m.subject}`).join('\n');
  const commitmentLines = inputs.commitments.length === 0
    ? '(ingen aktive løfter)'
    : inputs.commitments.map((c) => `- ${c}`).join('\n');
  const reminderLines = inputs.reminders.length === 0
    ? '(ingen påmindelser)'
    : inputs.reminders.map((r) => `- ${r.text}${r.dueIso ? ` (${r.dueIso})` : ''}`).join('\n');
  const weather = inputs.weather
    ? `Vejr: ${inputs.weather.tempC.toFixed(0)}°C, ${inputs.weather.conditionLabel} (høj ${inputs.weather.highC.toFixed(0)}°, lav ${inputs.weather.lowC.toFixed(0)}°)`
    : 'Vejr: ukendt';

  return [
    `Dagens briefing-type: ${inputs.kind}`,
    inputs.name ? `Bruger: ${inputs.name}` : '',
    `Møder:\n${eventLines}`,
    `Ulæste mails:\n${unreadLine}`,
    `Aktive løfter/aftaler:\n${commitmentLines}`,
    `Påmindelser:\n${reminderLines}`,
    weather,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export { SYSTEM as COMPOSER_SYSTEM, SCHEMA as COMPOSER_SCHEMA };

// Danish-friendly event line. Examples:
//   "14:30–15:30 Møde med Mette · Mødelokale 4"
//   "16:00–tirsdag 00:30 Vagt · Rox Resort"     (crosses midnight)
//   "Hele dagen · Teamdag"
// For events whose ISO lacks a zone designator (Microsoft Graph with
// Prefer: outlook.timezone returns naive local time), read HH:mm directly.
// Zone-aware ISO (Google RFC3339 with offset) goes through Intl formatting.
function formatEventLine(
  e: BriefInputs['events'][number],
  timezone: string,
): string {
  const locationSuffix = e.location ? ` · ${e.location}` : '';
  if (e.allDay) return `Hele dagen · ${e.title}${locationSuffix}`;
  const start = formatHM(e.startIso, timezone);
  const end = formatHM(e.endIso, timezone);
  const startDate = localDateParts(e.startIso, timezone);
  const endDate = localDateParts(e.endIso, timezone);
  // Cross-midnight / multi-day events used to render as a same-day range
  // ("16:00-00:30") with no signal of the day flip - users read this as
  // "ends at half past midnight tonight" or as a wildly wrong time. Prefix
  // the end time with the end weekday so briefer copy reflects reality.
  const crossesDay = startDate && endDate && startDate.ymd !== endDate.ymd;
  const endLabel = crossesDay && endDate ? `${endDate.weekday} ${end}` : end;
  return `${start}–${endLabel} ${e.title}${locationSuffix}`;
}

function formatHM(iso: string, timezone: string): string {
  // Naive ISO (no Z, no ±HH:mm after the time portion): already local time
  // in the caller's zone - parse HH:mm straight from the string.
  const naiveMatch = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(iso);
  const hasZoneDesignator = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (naiveMatch && !hasZoneDesignator) {
    return `${naiveMatch[1]}:${naiveMatch[2]}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

// Resolves the local calendar date for an event ISO, returning both the
// machine-friendly YYYY-MM-DD (for cross-day comparison) and the Danish
// weekday name (for display). Naive ISO strings from Microsoft Graph have
// the local date in the prefix and need no Intl conversion; zone-aware
// strings go through Intl with the user's IANA zone.
function localDateParts(
  iso: string,
  timezone: string,
): { ymd: string; weekday: string } | null {
  let year: number;
  let month: number;
  let day: number;
  const naiveMatch = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/.exec(iso);
  const hasZoneDesignator = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (naiveMatch && !hasZoneDesignator) {
    year = Number(naiveMatch[1]);
    month = Number(naiveMatch[2]);
    day = Number(naiveMatch[3]);
  } else {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    year = Number(parts.find((p) => p.type === 'year')?.value);
    month = Number(parts.find((p) => p.type === 'month')?.value);
    day = Number(parts.find((p) => p.type === 'day')?.value);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
  }
  const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Noon UTC anchor avoids any DST edge where local midnight could fall on
  // the previous calendar day when read back via Intl.
  const weekday = new Intl.DateTimeFormat('da-DK', {
    timeZone: 'UTC',
    weekday: 'long',
  })
    .format(new Date(Date.UTC(year, month - 1, day, 12)))
    .toLowerCase();
  return { ymd, weekday };
}
