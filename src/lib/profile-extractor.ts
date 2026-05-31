import { completeJson } from './claude';
import { findDuplicateFact, insertPendingFact, listFacts, normalizeFactText } from './profile-store';
import type { FactCategory } from './types';
import { getPrivacyFlag } from './hooks';
import { PROFILE_MEMORY_ENABLED, invalidatePreamble } from './profile';

type Trigger = 'chat_turn' | 'mail_draft' | 'mail_decision' | 'mail_reply';

type ExtractionPayload = {
  trigger: Trigger;
  userId: string;
  // Short free-text input the extractor reads. For chat this is the user's last turn + assistant's short reply. For mail it's the event-type + subject + from.
  text: string;
  source: string | null;
};

type Candidate = {
  text: string;
  category: FactCategory;
  confidence: number;
  // Optional ISO date (YYYY-MM-DD) when the fact references a specific moment
  // ("Oscar to vet Friday"). The decay logic uses this to set expires_at;
  // permanent facts (relations / role / preference / project) leave it null.
  referentDate?: string | null;
};

// Returns the current calendar day in Europe/Copenhagen as 'YYYY-MM-DD'.
// en-CA's date format is ISO-ordered, so this avoids manual zero-padding.
export function todayInCopenhagen(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const EXTRACTOR_SYSTEM =
  'Du læser et kort uddrag af samtale eller mailbeslutning og vurderer om der er én ny ' +
  'oplysning om dig værd at huske (relation, rolle, præference, igangværende projekt, eller løfte/aftale). ' +
  'Svar altid på dansk. Returnér højst ét kandidat-faktum.\n\n' +
  'HVAD DU IKKE SKAL EKSTRAHERE (returnér candidate: null):\n' +
  '- Engangshandlinger: "du vil sende X til Y", "du klikkede på en mail", "du har lige sendt en mail" - ' +
  'det er forbigående, ikke et fakta om dig.\n' +
  '- Påmindelser brugeren har bedt om: hvis teksten handler om at brugeren har sat (eller bedt om) en ' +
  'påmindelse - fx "påmind mig kl 20 om at ringe til Karl" eller en bekræftelse som "Oprettet påmindelse … ' +
  'til at ringe til Karl" - så returnér candidate: null. Påmindelsen er allerede gemt separat; den skal ' +
  'IKKE også huskes som et fakta.\n' +
  '- Fortidshandlinger uden fremadrettet betydning: "du har ignoreret en mail", "du har læst X", ' +
  '"du har afvist Y". Ignorér også "har set", "har klikket", "har scrollet".\n' +
  '- Flygtige følelser/tilstande: humør, sult, frokost, vejret.\n' +
  '- Information der allerede står i den medfølgende liste af eksisterende fakta - også hvis den er ' +
  'omformuleret med andre ord. Eksempel: hvis "du foretrækker at sende via iCloud" allerede findes, ' +
  'så ekstrahér IKKE "du sender helst via iCloud" eller "du vil bruge iCloud til at sende mail" - ' +
  'returnér candidate: null. Hvis det nye er DET MODSATTE af et eksisterende fakta, returnér også null ' +
  '(brugeren skal selv håndtere det modstridende).\n' +
  '- Gentagelser af samme intention med andre ord. Hellere returnere null end at lave en næsten-dublet.\n\n' +
  'HVIS det nye fakta refererer til en konkret dato eller dag (fx "fredag", "i morgen", "27. april"), ' +
  'så udfyld referentDate som en ISO-dato (YYYY-MM-DD). Ellers lad det være null.\n' +
  'Brugerbeskeden starter med en "Dags dato"-linje. Du SKAL regne relative danske datoer ' +
  '("i morgen", "i juni", "til oktober", "om to uger", "næste fredag") om til en konkret ISO-dato i ' +
  'referentDate ud fra netop den dags dato - gæt ALDRIG ud fra din egen træningsdato. Hvis en måned ' +
  'nævnes uden en bestemt dag (fx "i juni", "til oktober"), så brug den 1. i måneden. Har fakta ingen ' +
  'dato, så lad referentDate være null.\n\n' +
  'ADRESSERINGSKRAV (gælder text-feltet):\n' +
  '- Skriv ALTID direkte til personen med "du"/"dig"/"din"/"dit"/"dine".\n' +
  '- Brug ALDRIG ordene "bruger", "brugeren", "brugerens", "brugere".\n' +
  '- Brug ALDRIG personens eget navn i 3. person ("Oscar skal…", "Albert har…"). Skriv "du skal…" / "du har…" i stedet. Andre menneskers navne er fine ("Maria er din leder").\n' +
  '- Start ALDRIG med "huske", "husk", "skal jeg huske" eller "påmind". UI\'et viser allerede teksten som "Skal jeg huske at …?", så fakta skal være selve indholdet - fx "du skal gennemgå Mettes kontrakt fredag", IKKE "huske brugeren på at gennemgå Mettes kontrakt".\n' +
  '- Skriv som en kort, naturlig sætning der grammatisk passer efter "Skal jeg huske at …?".';

const EXTRACTOR_SCHEMA =
  '{"candidate": {"text": string, "category": "relationship" | "role" | "preference" | "project" | "commitment" | "other", "confidence": number (0 til 1), "referentDate": string | null} | null}\n' +
  '- text: en kort sætning på dansk i 2. person, fx "Maria er din leder", "du foretrækker morgenmøder", "du skal sende kontrakten til Mette fredag".\n' +
  '  Forkert: "Oscar skal til lægen", "huske brugeren på frokost", "Skal jeg huske at ringe til Anders". Korrekt: "du skal til lægen", "du skal til frokost med Lars", "du skal ringe til Anders".\n' +
  '- category: den bedst passende kategori.\n' +
  '- confidence: 0.6 eller mere hvis du er rimelig sikker; lavere hvis du gætter.\n' +
  '- referentDate: ISO-dato (YYYY-MM-DD) hvis fakta er knyttet til en bestemt dag; ellers null.';

// Action-y categories decay; relations/role/preference/project are permanent.
const DECAY_CATEGORIES: ReadonlySet<FactCategory> = new Set(['commitment', 'other']);
// Fallback decay window when the model can't infer a referent date.
const DEFAULT_DECAY_MS = 3 * 24 * 60 * 60 * 1000;
// Buffer kept after the referent date so a "fredag" fact is still in the
// brief on Friday morning and only drops out the day after.
const REFERENT_GRACE_MS = 24 * 60 * 60 * 1000;

function computeExpiresAt(category: FactCategory, referentDate: string | null | undefined): Date | null {
  if (!DECAY_CATEGORIES.has(category)) return null;
  if (referentDate && /^\d{4}-\d{2}-\d{2}$/.test(referentDate)) {
    const base = Date.parse(`${referentDate}T00:00:00Z`);
    if (Number.isFinite(base)) {
      return new Date(base + REFERENT_GRACE_MS);
    }
  }
  return new Date(Date.now() + DEFAULT_DECAY_MS);
}

// Follow-up-eligible categories are the actionable ones (same set that decays).
// A memory follow-up only makes sense for a thing-to-do, not a preference/role.
const FOLLOWUP_CATEGORIES: ReadonlySet<FactCategory> = DECAY_CATEGORIES;

// follow_up_at = the referent day at 00:00 UTC (~02:00 Copenhagen). The sweep is
// quiet-hours gated, so an overnight-due fact actually surfaces the first sweep
// after quiet hours that morning. Null when the fact is not a dated actionable
// item — those never enter the follow-up sweep. v1 surfaces ON the day; a smarter
// lead (e.g. two weeks before an expiry) is a future refinement.
export function computeFollowUpAt(
  category: FactCategory,
  referentDate: string | null | undefined,
): Date | null {
  if (!FOLLOWUP_CATEGORIES.has(category)) return null;
  if (referentDate && /^\d{4}-\d{2}-\d{2}$/.test(referentDate)) {
    const base = Date.parse(`${referentDate}T00:00:00Z`);
    if (Number.isFinite(base)) return new Date(base);
  }
  return null;
}

const CONFIDENCE_THRESHOLD = 0.6;
const DEBOUNCE_MS = 2000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<string>();

export function runExtractor(payload: ExtractionPayload): void {
  if (!PROFILE_MEMORY_ENABLED) return;
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

async function runNow(payload: ExtractionPayload): Promise<void> {
  try {
    // Fetch the user's existing pending+confirmed facts so the extractor
    // can detect paraphrase duplicates ("du foretrækker iCloud" vs "du
    // sender helst via iCloud") and contradictions. Capped to keep token
    // costs predictable; most-recent-first under listFacts's order.
    const [pending, confirmed] = await Promise.all([
      listFacts(payload.userId, 'pending').catch(() => []),
      listFacts(payload.userId, 'confirmed').catch(() => []),
    ]);
    const existingTexts = [...pending, ...confirmed]
      .map((f) => f.text.trim())
      .filter(Boolean)
      .slice(0, 30);
    const existingBlock = existingTexts.length > 0
      ? `Eksisterende fakta om brugeren (returnér candidate: null hvis det nye uddrag er en omformulering af noget herfra):\n${existingTexts.map((t) => `- ${t}`).join('\n')}\n\n`
      : '';
    // The date lives in the per-call user message (not the cached system block)
    // because it changes daily; the system prompt stays static and cacheable.
    const dateBlock = `Dags dato: ${todayInCopenhagen(new Date())} (Europe/Copenhagen).\n\n`;
    const userMessage = `${dateBlock}${existingBlock}Nyt uddrag:\n${payload.text}`;

    const result = await completeJson<{ candidate: Candidate | null }>({
      system: EXTRACTOR_SYSTEM,
      schemaHint: EXTRACTOR_SCHEMA,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 200,
      temperature: 0.2,
      attachProfile: false,
    });
    const c = result.candidate;
    if (!c || c.confidence < CONFIDENCE_THRESHOLD) return;
    const normalized = normalizeFactText(c.text);
    if (!normalized) return;
    const duplicate = await findDuplicateFact(payload.userId, normalized);
    if (duplicate) return;
    await insertPendingFact(payload.userId, {
      text: c.text.trim(),
      category: c.category,
      source: payload.source,
      expiresAt: computeExpiresAt(c.category, c.referentDate ?? null),
      followUpAt: computeFollowUpAt(c.category, c.referentDate ?? null),
    });
    invalidatePreamble(payload.userId);
  } catch (err) {
    if (__DEV__) console.warn('[profile-extractor] run failed:', err);
  }
}
