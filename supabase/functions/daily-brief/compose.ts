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
  tone: 'calm' | 'busy' | 'heads-up';
  // Structured sections. The calendar section is rendered deterministically
  // from the real events (see formatCalendarLines) and is NOT produced by the
  // model - so it never appears here. The model fills these four lists, each a
  // set of short strings.
  mails: string[];
  followups: string[];
  focus: string[];
  weather: string[];
};

const SYSTEM =
  'Du er Zolva, en rolig dansk AI-assistent. Du laver en kort, struktureret ' +
  '{kind}-brief til brugeren, opdelt i faste sektioner. Du modtager dagens rå data ' +
  '(kalenderbegivenheder, ulæste mails, aktive løfter/aftaler, påmindelser og vejr) og omsætter dem ' +
  'til korte, handlingsorienterede punkter.\n\n' +
  'KALENDEREN INDEHOLDER ALT MULIGT - ikke kun arbejdsmøder. Aflæs begivenhedens art ud fra ' +
  'titlen og omtal den derefter: en fest er en fest, en fødselsdag en fødselsdag, en middag ' +
  'en middag, en lægetid en lægetid, tid med familien er samvær - IKKE et møde. Kald KUN noget ' +
  'et "møde", når titlen tydeligt peger på et arbejdsmøde (fx 1:1, statusmøde, kundemøde). ' +
  'Er du i tvivl, brug neutrale ord som "aftalen" eller begivenhedens egen titel. ' +
  'Match også tonen: private og sociale begivenheder skal ikke omtales med arbejdssprog.\n\n' +
  'DAGTYPE: Du får at vide hvilken ugedag det er, og om det er weekend. I weekender og på ' +
  'fridage skal briefen have fri-tone: foreslå ALDRIG "fordybelsesarbejde", "mindre opgaver" ' +
  'eller anden arbejdsprioritering, medmindre kalenderen tydeligt viser arbejde. Lad dagen ' +
  'være brugerens - fokuser på det sociale/praktiske og på at være klar til dagens begivenheder.\n\n' +
  'NAVN: Hvis du får brugerens navn, må du bruge fornavnet naturligt i headline eller focus ' +
  '(fx "God lørdag, Oscar - fri formiddag før gildet"), men højst ét sted. Aldrig påtaget eller gentaget.\n\n' +
  'SEKTIONER du skal udfylde (hver er en liste af korte strenge - brug tom liste hvis intet er relevant):\n' +
  '- mails: ét kort handlingspunkt i bydeform pr. ulæst mail der kræver handling, fx ' +
  '"Svar på tilbud til Kunde A fra Mads Larsen" eller "Godkend eksternt design fra Marketingbureauet". ' +
  'Spring mails over der ikke kræver handling.\n' +
  '- followups: konkrete opfølgninger brugeren bør gøre i dag, udledt af aktive løfter/aftaler, ' +
  'påmindelser og dagens begivenheder. Bydeform, fx "Følg op på tilbud til Kunde A", ' +
  '"Send præsentation til Mads efter 1:1".\n' +
  '- focus: 1-2 korte sætninger med et forslag til hvordan brugeren bør prioritere dagen, ' +
  'skrevet direkte til brugeren med "du", fx "Du har flere møder i formiddags. ' +
  'Overvej at lægge fordybelsesarbejde i eftermiddagen."\n' +
  '- weather: 1-2 korte sætninger om vejret med et praktisk råd, fx ' +
  '"14°C og mest skyet. Tag en let jakke med, hvis du går ud." Tom liste hvis vejret er ukendt.\n\n' +
  'GENTAG ALDRIG kalenderen: begivenhederne vises i en separat sektion, så skriv dem ikke som ' +
  'punkter i mails/followups/focus. Du må dog henvise til en begivenhed i en opfølgning ' +
  '(fx "efter 1:1 med Mads").\n\n' +
  'ADRESSERINGSKRAV (obligatorisk):\n' +
  '- Skriv ALTID direkte til brugeren med "du", "dig", "din", "dit", "dine".\n' +
  '- Omtal ALDRIG brugeren i 3. person ved navn eller som "han"/"hun"/"de"/"brugeren".\n\n' +
  'SPROGKRAV: Skriv udelukkende på rigsdansk. Brug ALDRIG norske eller svenske ord eller bøjninger. ' +
  'Typiske fejl at undgå:\n' +
  '- Skriv "møderne" (ikke "møtene"/"møterne")\n' +
  '- Skriv "inden" eller "før" (ikke "innan")\n' +
  '- Skriv "skal" eller "er nødt til" (ikke "måste")\n' +
  '- Skriv "også" (ikke "också")\n' +
  '- Skriv "pludselig" (ikke "plutseligt")\n' +
  '- Brug danske artikler og endelser: -en/-et/-erne, aldrig -et/-ene på norsk vis\n' +
  'Hvis du er i tvivl om et ord, vælg det mest almindelige danske hverdagsord.\n\n' +
  'Hold punkterne korte (ca. 8 ord pr. mail-/followup-punkt). ' +
  'headline er en kort overskrift til push-notifikationen (under 60 tegn), skrevet til brugeren. ' +
  'Vælg tone baseret på hvor presset dagen ser ud: "calm" (rolig), "busy" (pakket), "heads-up" (noget haster).';

const SCHEMA =
  '{"headline": string, "tone": "calm" | "busy" | "heads-up", "mails": string[], ' +
  '"followups": string[], "focus": string[], "weather": string[]}\n' +
  '- headline: kort push-overskrift (under 60 tegn).\n' +
  '- mails/followups: korte handlingspunkter i bydeform (tom liste hvis ingen).\n' +
  '- focus: 1-2 sætninger med dagens prioritering.\n' +
  '- weather: 1-2 sætninger om vejret (tom liste hvis ukendt).\n' +
  '- tone: matcher dagens pres.';

// Danish day line for the composer, e.g. "lørdag den 11. juli (weekend)".
// Weekday resolved in the user's timezone so briefs composed around midnight
// UTC still describe the user's actual local day.
function formatDayLine(timezone: string): string {
  try {
    const now = new Date();
    const label = new Intl.DateTimeFormat('da-DK', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(now);
    const weekdayShort = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(now);
    const isWeekend = weekdayShort === 'Sat' || weekdayShort === 'Sun';
    return `${label}${isWeekend ? ' (weekend)' : ''}`;
  } catch {
    return '';
  }
}

export function buildComposerMessage(inputs: BriefInputs): string {
  const eventLines = inputs.events.length === 0
    ? '(ingen begivenheder)'
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

  const dayLine = formatDayLine(inputs.timezone);
  return [
    `Dagens briefing-type: ${inputs.kind}`,
    dayLine ? `Dag: ${dayLine}` : '',
    inputs.name ? `Bruger: ${inputs.name}` : '',
    `Kalender:\n${eventLines}`,
    `Ulæste mails:\n${unreadLine}`,
    `Aktive løfter/aftaler:\n${commitmentLines}`,
    `Påmindelser:\n${reminderLines}`,
    weather,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export { SYSTEM as COMPOSER_SYSTEM, SCHEMA as COMPOSER_SCHEMA };

// Deterministic "Din kalender" section. We render meeting times straight from
// the real events rather than letting the model paraphrase them - the times
// are exact, the cross-midnight handling is already solved in formatEventLine,
// and the model can't drift or hallucinate a time it never saw.
export function formatCalendarLines(inputs: BriefInputs): string[] {
  return inputs.events.map((e) => formatEventLine(e, inputs.timezone));
}

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
