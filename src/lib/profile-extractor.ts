import { completeJson } from './claude';
import { findDuplicateFact, insertPendingFact, normalizeFactText } from './profile-store';
import type { FactCategory } from './types';
import { getPrivacyFlag } from './hooks';
import { invalidatePreamble } from './profile';

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
};

const EXTRACTOR_SYSTEM =
  'Du læser et kort uddrag af samtale eller mailbeslutning og vurderer om der er én ny, ' +
  'varig oplysning om brugeren værd at huske (relation, rolle, præference, igangværende projekt, eller løfte). ' +
  'Svar altid på dansk. Tag kun fakta frem der vil være relevante om en uge eller mere. ' +
  'Ignorér flygtige ting (humør, hvad brugeren spiser til frokost). Returnér højst ét kandidat-faktum.';

const EXTRACTOR_SCHEMA =
  '{"candidate": {"text": string, "category": "relationship" | "role" | "preference" | "project" | "commitment" | "other", "confidence": number (0 til 1)} | null}\n' +
  '- text: en kort sætning på dansk, fx "Maria er din leder".\n' +
  '- category: den bedst passende kategori.\n' +
  '- confidence: 0.6 eller mere hvis du er rimelig sikker; lavere hvis du gætter.';

const CONFIDENCE_THRESHOLD = 0.6;
const DEBOUNCE_MS = 2000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflight = new Set<string>();

export function runExtractor(payload: ExtractionPayload): void {
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
    });
    invalidatePreamble(payload.userId);
  } catch (err) {
    if (__DEV__) console.warn('[profile-extractor] run failed:', err);
  }
}
