// src/lib/network-extractor.ts
//
// AI-ekstraktion til Netværk: læser chat-ture og talenoter og finder
// personer brugeren har mødt ("Jeg mødte Lars fra Volvo…"). Parallel til
// profile-extractor (samme guards, debounce og fire-and-forget-mønster),
// men med sit eget skema og — det centrale — identitetsopløsning: modellen
// får en roster af eksisterende personer og SKAL matche mod den frem for
// at oprette dubletter.
import { completeJson } from './claude';
import { isDemoUserId } from './demo-data';
import { getPrivacyFlag } from './hooks';
import { shouldAutoConfirm, todayInCopenhagen } from './profile-extractor';
import { PROFILE_MEMORY_ENABLED } from './profile';
import {
  addFollowup,
  addInteraction,
  findRosterMatch,
  insertNetworkPerson,
  listNetworkPeople,
  listOpenFollowups,
  mergeAiIntoPerson,
  updateNetworkPersonFields,
  type AiPersonFields,
  type NetworkPerson,
} from './network-store';
import { normalizeFactText } from './profile-store';

type NetworkTrigger = 'chat_turn' | 'voice_note';

export type NetworkExtractionPayload = {
  trigger: NetworkTrigger;
  userId: string;
  // Kort fritekst: for chat er det brugerens tur + assistentens svar,
  // for talenoter selve transskriptionen.
  text: string;
  source: string | null;
};

type ExtractedPerson = AiPersonFields & {
  existing_id: string | null;
  name: string;
  how_we_met?: string | null;
  interaction_note?: string | null;
  confidence: number;
  followups?: Array<{ text: string; due_date: string | null }>;
};

const EXTRACTOR_SYSTEM =
  'Du læser et kort uddrag af en samtale eller talenote og finder personer brugeren ' +
  'SELV har mødt eller kender - kolleger, kunder, venner, nye bekendtskaber. ' +
  'I langt de fleste uddrag er der ingen: returnér people: [].\n\n' +
  'IKKE personer: kendte/offentlige personer, firmaer uden en konkret person, brugeren selv, ' +
  'personer der kun optræder som mailafsendere eller i tredjehåndsomtale uden relation til brugeren.\n\n' +
  'MATCH FØRST: brugerbeskeden indeholder en liste over eksisterende personer i netværket. ' +
  'Hvis en nævnt person svarer til én på listen - også ved fornavn alene, kaldenavn eller en ' +
  'beskrivelse som "ham fra Volvo" - så sæt existing_id til personens id og udfyld KUN de felter ' +
  'uddraget tilføjer noget nyt til. Opret ALDRIG en dublet af én på listen.\n\n' +
  'FYSISKE KENDETEGN (traits): KUN når brugeren udtrykkeligt beskriver udseende ' +
  '("mørkt hår", "høj", "briller"). Gæt aldrig, og udled aldrig udseende af navn, køn eller job. ' +
  'Er intet udseende nævnt, skal traits være [].\n\n' +
  'FØLG-OP (followups): løfter om at mødes, kontakte eller sende noget igen. Brugerbeskeden ' +
  'starter med en "Dags dato"-linje - regn relative danske tidsangivelser om til en ISO-dato ' +
  '(YYYY-MM-DD) ud fra netop den dato, gæt aldrig ud fra din egen træningsdato. "Efter ' +
  'sommerferien" -> første uge af august samme år; "efter nytår" -> første uge af januar året ' +
  'efter. Nævnes ingen tid, så sæt due_date: null.\n\n' +
  'interaction_note: én kort sætning om hvad mødet/samtalen handlede om ("Talte om AI i ' +
  'kundeservice til netværksmiddag"), null hvis uddraget intet konkret siger.\n' +
  'summary: én linje der hjælper brugeren med at huske hvem personen er.\n' +
  'Alle tekstfelter på dansk og korte. confidence: 0.85+ når personen er tydeligt beskrevet, ' +
  '0.6-0.85 når du er i tvivl om navn eller detaljer, under 0.6 når du gætter.';

const EXTRACTOR_SCHEMA =
  '{"people": [{"existing_id": string | null, "name": string, "company": string | null, ' +
  '"role": string | null, "relation": string | null, "industry": string | null, ' +
  '"how_we_met": string | null, "location": string | null, "email": string | null, ' +
  '"phone": string | null, "linkedin": string | null, ' +
  '"traits": string[], "interests": string[], "projects": string[], ' +
  '"summary": string | null, "interaction_note": string | null, ' +
  '"confidence": number (0 til 1), ' +
  '"followups": [{"text": string, "due_date": string | null (YYYY-MM-DD)}]}]}\n' +
  '- existing_id: id fra listen over eksisterende personer ved match, ellers null.\n' +
  '- relation: kort dansk beskrivelse, fx "kunde", "kollega", "ny kontakt".\n' +
  '- followups: tomt array hvis ingen løfter om opfølgning.';

const CONFIDENCE_THRESHOLD = 0.6;
const ROSTER_CAP = 100;
const DEBOUNCE_MS = 2000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<string>();

// Samme fire-and-forget-mønster som profile-extractor: chatten har ingen
// naturlig callback når en person lander, så en listener-bus lader
// PapirChat vise sin "Tilføjet til netværk"-mikrobekræftelse.
export type NetworkExtractedEvent = {
  userId: string;
  personId: string;
  name: string;
  isNew: boolean;
  source: string | null;
};

const networkExtractedListeners = new Set<(e: NetworkExtractedEvent) => void>();

export function subscribeNetworkExtracted(
  listener: (e: NetworkExtractedEvent) => void,
): () => void {
  networkExtractedListeners.add(listener);
  return () => {
    networkExtractedListeners.delete(listener);
  };
}

export function runNetworkExtractor(payload: NetworkExtractionPayload): void {
  if (!PROFILE_MEMORY_ENABLED) return;
  // Demo: netværket er kurateret på forhånd — ekstraktoren skal hverken
  // ramme netværket (API'et) eller ændre demo-dataene.
  if (isDemoUserId(payload.userId)) return;
  if (!getPrivacyFlag('memory-enabled')) return;
  const key = `${payload.userId}:${payload.trigger}`;
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    if (inflight.has(key)) return;
    inflight.add(key);
    void runNow(payload).finally(() => {
      inflight.delete(key);
    });
  }, DEBOUNCE_MS);
  debounceTimers.set(key, timer);
}

function rosterLine(p: NetworkPerson): string {
  const bits = [p.name];
  if (p.company) bits.push(p.company);
  if (p.role) bits.push(p.role);
  else if (p.relation) bits.push(p.relation);
  return `- [id: ${p.id}] ${bits.join(' — ')}`;
}

async function runNow(payload: NetworkExtractionPayload): Promise<void> {
  try {
    const people = await listNetworkPeople(payload.userId);
    const roster = people.slice(0, ROSTER_CAP);
    const rosterBlock = roster.length > 0
      ? `Eksisterende personer i brugerens netværk (match mod disse før du opretter nye):\n${roster.map(rosterLine).join('\n')}\n\n`
      : 'Brugerens netværk er tomt endnu.\n\n';
    const dateBlock = `Dags dato: ${todayInCopenhagen(new Date())} (Europe/Copenhagen).\n\n`;
    const result = await completeJson<{ people: ExtractedPerson[] | null }>({
      system: EXTRACTOR_SYSTEM,
      schemaHint: EXTRACTOR_SCHEMA,
      messages: [{ role: 'user', content: `${dateBlock}${rosterBlock}Nyt uddrag:\n${payload.text}` }],
      maxTokens: 600,
      temperature: 0.2,
      attachProfile: false,
    });
    const extracted = Array.isArray(result.people) ? result.people : [];
    for (const person of extracted) {
      if (!person || typeof person.name !== 'string' || !person.name.trim()) continue;
      if (typeof person.confidence !== 'number' || person.confidence < CONFIDENCE_THRESHOLD) continue;
      await applyExtractedPerson(payload, people, person);
    }
  } catch (err) {
    if (__DEV__) console.warn('[network-extractor] run failed:', err);
  }
}

function toAiFields(p: ExtractedPerson): AiPersonFields {
  return {
    company: p.company ?? null,
    role: p.role ?? null,
    relation: p.relation ?? null,
    industry: p.industry ?? null,
    howWeMet: p.how_we_met ?? null,
    location: p.location ?? null,
    email: p.email ?? null,
    phone: p.phone ?? null,
    linkedin: p.linkedin ?? null,
    traits: Array.isArray(p.traits) ? p.traits : [],
    interests: Array.isArray(p.interests) ? p.interests : [],
    projects: Array.isArray(p.projects) ? p.projects : [],
    summary: p.summary ?? null,
  };
}

function parseDueDate(dueDate: string | null | undefined): Date | null {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  const ms = Date.parse(`${dueDate}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function applyExtractedPerson(
  payload: NetworkExtractionPayload,
  roster: NetworkPerson[],
  extracted: ExtractedPerson,
): Promise<void> {
  const fields = toAiFields(extracted);
  // Modellens match først; falder den tilbage til "ny", fanger det
  // deterministiske navnematch stadig en oplagt eksisterende person.
  const byId = extracted.existing_id
    ? roster.find((p) => p.id === extracted.existing_id) ?? null
    : null;
  const deterministic = findRosterMatch(roster, extracted.name, extracted.company ?? null);
  const match = byId ?? deterministic;

  let personId: string;
  let isNew: boolean;
  if (match) {
    // Konfidens-gaten her handler om IDENTITET (skriv aldrig på den forkerte
    // person) — selve merget er allerede konservativt (udfylder kun tomme,
    // ikke bruger-redigerede felter). Bekræfter det deterministiske
    // navnematch personen, rækker basis-tærsklen; ellers droppede en
    // opfølgnings-note ("Dennis er kok der…") lydløst alt. Kun et rent
    // model-match (existing_id uden navnestøtte) kræver stadig høj konfidens.
    const identityCertain = deterministic != null && deterministic.id === match.id;
    if (!identityCertain && !shouldAutoConfirm(extracted.confidence)) return;
    const patch = mergeAiIntoPerson(match, fields);
    await updateNetworkPersonFields(payload.userId, match.id, patch ?? {}, {
      lastContactedAt: new Date(),
    });
    personId = match.id;
    isNew = false;
  } else {
    const inserted = await insertNetworkPerson(payload.userId, {
      ...fields,
      name: extracted.name.trim(),
      status: shouldAutoConfirm(extracted.confidence) ? 'confirmed' : 'pending',
      source: payload.source,
    });
    personId = inserted.id;
    isNew = true;
  }

  if (extracted.interaction_note && extracted.interaction_note.trim()) {
    await addInteraction(payload.userId, personId, {
      kind: payload.trigger === 'voice_note' ? 'voice' : 'chat',
      summary: extracted.interaction_note.trim(),
      sourceRef: payload.source,
    });
  }

  const followups = Array.isArray(extracted.followups) ? extracted.followups : [];
  if (followups.length > 0) {
    const open = (await listOpenFollowups(payload.userId)).filter((f) => f.personId === personId);
    const seen = new Set(open.map((f) => normalizeFactText(f.text)));
    for (const f of followups) {
      if (!f || typeof f.text !== 'string' || !f.text.trim()) continue;
      const normalized = normalizeFactText(f.text);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      await addFollowup(payload.userId, personId, {
        text: f.text.trim(),
        dueAt: parseDueDate(f.due_date),
        source: payload.source,
      });
    }
  }

  const event: NetworkExtractedEvent = {
    userId: payload.userId,
    personId,
    name: extracted.name.trim(),
    isNew,
    source: payload.source,
  };
  networkExtractedListeners.forEach((l) => l(event));
}
