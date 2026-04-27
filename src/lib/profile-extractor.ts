import { completeJson } from './claude';
import { findDuplicateFact, insertPendingFact, normalizeFactText } from './profile-store';
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

const EXTRACTOR_SYSTEM =
  'Du læser et kort uddrag af samtale eller mailbeslutning og vurderer om der er én ny, ' +
  'oplysning om brugeren værd at huske (relation, rolle, præference, igangværende projekt, eller løfte/aftale). ' +
  'Svar altid på dansk. Ignorér helt flygtige ting (humør, hvad brugeren spiser til frokost). ' +
  'Hvis fakta refererer til en konkret dato eller dag (fx "fredag", "i morgen", "27. april"), ' +
  'så udfyld referentDate som en ISO-dato (YYYY-MM-DD). Ellers lad det være null. ' +
  'Returnér højst ét kandidat-faktum.';

const EXTRACTOR_SCHEMA =
  '{"candidate": {"text": string, "category": "relationship" | "role" | "preference" | "project" | "commitment" | "other", "confidence": number (0 til 1), "referentDate": string | null} | null}\n' +
  '- text: en kort sætning på dansk, fx "Maria er din leder".\n' +
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
    const result = await completeJson<{ candidate: Candidate | null }>({
      system: EXTRACTOR_SYSTEM,
      schemaHint: EXTRACTOR_SCHEMA,
      messages: [{ role: 'user', content: payload.text }],
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
    });
    invalidatePreamble(payload.userId);
  } catch (err) {
    if (__DEV__) console.warn('[profile-extractor] run failed:', err);
  }
}
