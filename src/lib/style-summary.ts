// Style-summary analyzer: pulls a sample of the user's sent mails,
// asks Claude to summarize how they write, and persists the result so
// the draft generator can sound progressively more like them. Each
// connected provider gets its own summary - they're combined into one
// style block at draft time. Refreshes every 14 days so a shifted
// writing style (new role, different audience) eventually flows in.
//
// Storage: work_preferences row with id='style.{provider}'. Reuses the
// existing per-user key/value table so no migration is needed.

import { complete, hasClaudeKey } from './claude';
import { supabase } from './supabase';

export type StyleProvider = 'google' | 'microsoft' | 'icloud';

const STYLE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const STYLE_SYSTEM =
  'You analyze a user\'s sent emails to summarize their writing style. ' +
  'The summary is fed back into prompts that draft new replies on their behalf, ' +
  'so be concrete and specific. ' +
  'Output 2-3 sentences in English describing: ' +
  '(1) overall tone and formality (warm / direct / formal / playful), ' +
  '(2) sentence length and structure tendencies, ' +
  '(3) common openers, sign-offs, and recurring phrases. ' +
  'If the user writes in a non-English language, name the primary language and any code-switching pattern. ' +
  'Never include the user\'s name, the recipient\'s name, or quoted recipient text. ' +
  'Output ONLY the style summary - no preamble, no labels.';

async function summarizeStyle(samples: string[]): Promise<string | null> {
  if (samples.length < 3 || !hasClaudeKey()) return null;
  const userBlock = samples.map((s, i) => `Sample ${i + 1}:\n${s}`).join('\n\n---\n\n');
  try {
    const result = await complete({
      system: STYLE_SYSTEM,
      messages: [{ role: 'user', content: userBlock }],
      maxTokens: 240,
      temperature: 0.3,
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if (__DEV__) console.warn('[style-summary] summarize failed:', (err as Error).message);
    return null;
  }
}

async function loadRow(userId: string, provider: StyleProvider) {
  const { data, error } = await supabase
    .from('work_preferences')
    .select('value, updated_at')
    .eq('user_id', userId)
    .eq('id', `style.${provider}`)
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}

async function saveRow(userId: string, provider: StyleProvider, value: string): Promise<void> {
  const { error } = await supabase.from('work_preferences').upsert(
    { user_id: userId, id: `style.${provider}`, value, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,id' },
  );
  if (error && __DEV__) console.warn('[style-summary] save failed:', error.message);
}

// Called once per provider on app launch (and whenever a token changes).
// No-ops when fresh enough; otherwise pulls samples and re-summarizes.
// Fire-and-forget from callers - the next draft generated after this
// resolves will pick up the new summary, earlier ones gracefully skip
// the style cue.
export async function ensureStyleSummary(
  userId: string,
  provider: StyleProvider,
  fetchSamples: () => Promise<string[]>,
): Promise<void> {
  if (!userId) return;
  try {
    const existing = await loadRow(userId, provider);
    if (existing?.updated_at) {
      const age = Date.now() - new Date(existing.updated_at).getTime();
      if (age >= 0 && age < STYLE_TTL_MS) return;
    }
    const samples = await fetchSamples();
    const summary = await summarizeStyle(samples);
    if (!summary) return;
    await saveRow(userId, provider, summary);
  } catch (err) {
    if (__DEV__) console.warn(`[style-summary] ensure ${provider} failed:`, (err as Error).message);
  }
}

export type CombinedStyle = {
  google: string | null;
  microsoft: string | null;
  icloud: string | null;
};

export async function loadCombinedStyle(userId: string): Promise<CombinedStyle> {
  const empty: CombinedStyle = { google: null, microsoft: null, icloud: null };
  if (!userId) return empty;
  try {
    const { data } = await supabase
      .from('work_preferences')
      .select('id, value')
      .eq('user_id', userId)
      .in('id', ['style.google', 'style.microsoft', 'style.icloud']);
    const out = { ...empty };
    for (const r of data ?? []) {
      if (r.id === 'style.google') out.google = r.value;
      if (r.id === 'style.microsoft') out.microsoft = r.value;
      if (r.id === 'style.icloud') out.icloud = r.value;
    }
    return out;
  } catch {
    return empty;
  }
}

// Combine the per-provider summaries into a single block for the draft
// system prompt. Multiple providers usually overlap heavily (same person
// writes both Gmail and iCloud) so we join with a soft separator and
// trust the draft model to handle redundancy.
export function combineStyleForPrompt(style: CombinedStyle): string | null {
  const parts = [style.google, style.microsoft, style.icloud].filter(
    (p): p is string => !!p && p.trim().length > 0,
  );
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return parts.join(' Across providers: ');
}
