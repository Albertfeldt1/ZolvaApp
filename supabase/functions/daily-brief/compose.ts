import { Weather } from './weather.ts';

export type BriefInputs = {
  kind: 'morning' | 'evening';
  name: string | null;
  events: Array<{ title: string; startIso: string; endIso: string; location?: string }>;
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
  '{kind}-brief til brugeren. Svar altid på dansk. Max 3–5 sætninger i body. ' +
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
        .map((e) => `- ${e.startIso}–${e.endIso} ${e.title}${e.location ? ` @ ${e.location}` : ''}`)
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
