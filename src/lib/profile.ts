// Persistent memory feature (spec: docs/superpowers/specs/2026-04-21-persistent-memory-design.md).
// Gated by the user's memory-enabled toggle. When off, no preamble is built,
// no extractor fires, no chat sync, no mail events recorded.

// App-level kill switch for the persistent-memory feature (phased rollout).
// Evaluated once at module load — env vars are static in RN. Default-off:
// missing var (e.g. fresh install with stale .env.example) reads as disabled,
// matching the spec's "off until explicitly enabled" intent. The per-user
// `memory-enabled` privacy toggle is the second gate — both must be true.
export const PROFILE_MEMORY_ENABLED =
  process.env.EXPO_PUBLIC_PROFILE_MEMORY === '1';

import type { Fact, FactCategory, MailEvent, ChatMessageRow } from './types';
import {
  getFactsSignature,
  listFacts,
  listRecentChatMessages,
  listRecentMailEvents,
} from './profile-store';
import { DEMO_PROFILE_PREAMBLE } from './profile-demo';
import { isDemoUser } from './demo';
import { subscribeUserId } from './auth';

const PREAMBLE_TOKEN_CAP = 800;
const CONTEXT_LINE_CHAR_CAP = 120;

// Rough char -> token ratio. Anthropic tokenizer averages ~4 chars/token for Danish text.
function approxTokenCount(s: string): number {
  return Math.ceil(s.length / 4);
}

function factsHeading(cat: FactCategory): string | null {
  switch (cat) {
    case 'role':
    case 'preference':
    case 'other':
      return 'Om brugeren';
    case 'relationship':
      return 'Relationer';
    case 'project':
      return 'Igangværende';
    case 'commitment':
      return 'Løfter og aftaler';
    default:
      return null;
  }
}

function groupFactsBySection(facts: Fact[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of facts) {
    const heading = factsHeading(f.category);
    if (!heading) continue;
    const arr = groups.get(heading) ?? [];
    arr.push(`• ${f.text.trim()}`);
    groups.set(heading, arr);
  }
  return groups;
}

function renderChatContext(rows: ChatMessageRow[]): string[] {
  return rows.map((r) => {
    const prefix = r.role === 'user' ? 'Bruger' : 'Zolva';
    const text = r.content.replace(/\s+/g, ' ').trim();
    const truncated = text.length > CONTEXT_LINE_CHAR_CAP
      ? text.slice(0, CONTEXT_LINE_CHAR_CAP - 1) + '…'
      : text;
    return `• ${prefix}: ${truncated}`;
  });
}

function renderMailEventContext(rows: MailEvent[]): string[] {
  return rows.map((r) => {
    const from = r.providerFrom ?? 'ukendt afsender';
    const subject = r.providerSubject ?? '(intet emne)';
    const verb: Record<MailEvent['eventType'], string> = {
      read: 'læst',
      deferred: 'udskudt',
      dismissed: 'ignoreret',
      drafted_reply: 'udkast lavet',
      replied: 'besvaret',
    };
    return `• ${from}: "${subject}" — ${verb[r.eventType]} ${timeAgo(r.occurredAt)}`;
  });
}

function timeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m siden`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}t siden`;
  const days = Math.floor(hours / 24);
  return `${days}d siden`;
}

export async function buildProfilePreambleFromData(data: {
  facts: Fact[];
  chat: ChatMessageRow[];
  mail: MailEvent[];
}): Promise<string> {
  const sections: string[] = [];
  const grouped = groupFactsBySection(data.facts.filter((f) => f.status === 'confirmed'));

  for (const heading of ['Om brugeren', 'Relationer', 'Igangværende', 'Løfter og aftaler']) {
    const bullets = grouped.get(heading);
    if (!bullets || bullets.length === 0) continue;
    sections.push(`${heading}:\n${bullets.join('\n')}`);
  }

  const chatLines = renderChatContext(data.chat);
  const mailLines = renderMailEventContext(data.mail);
  if (chatLines.length || mailLines.length) {
    sections.push(
      `Seneste kontekst:\n${[...chatLines, ...mailLines].join('\n')}`,
    );
  }

  if (sections.length === 0) return '';

  // Budget: drop trailing context lines until under PREAMBLE_TOKEN_CAP.
  // We only trim the Seneste kontekst section because facts are load-bearing.
  let text = sections.join('\n\n');
  const contextSectionIndex = sections.length - 1;
  let contextLines = [...chatLines, ...mailLines];
  while (approxTokenCount(text) > PREAMBLE_TOKEN_CAP && contextLines.length > 0) {
    contextLines = contextLines.slice(0, -1);
    sections[contextSectionIndex] =
      contextLines.length > 0
        ? `Seneste kontekst:\n${contextLines.join('\n')}`
        : '';
    text = sections.filter(Boolean).join('\n\n');
  }
  return text;
}

type CachedPreamble = { signature: string; value: string };
const preambleCache = new Map<string, CachedPreamble>();

subscribeUserId(() => {
  preambleCache.clear();
});

export function invalidatePreamble(userId: string): void {
  preambleCache.delete(userId);
}

export async function buildProfilePreamble(
  userId: string,
  opts?: { user?: { id: string; isDemo?: boolean } },
): Promise<string> {
  // Demo users get a pre-baked preamble; never touches Supabase.
  if (opts?.user && isDemoUser(opts.user as never)) return DEMO_PROFILE_PREAMBLE;
  // App-level kill switch — see PROFILE_MEMORY_ENABLED comment at module top.
  if (!PROFILE_MEMORY_ENABLED) return '';

  try {
    const signature = await getFactsSignature(userId);
    const cached = preambleCache.get(userId);
    if (cached && cached.signature === signature) return cached.value;
    const [facts, chat, mail] = await Promise.all([
      listFacts(userId, 'confirmed'),
      listRecentChatMessages(userId, 3),
      listRecentMailEvents(userId, 5),
    ]);
    const value = await buildProfilePreambleFromData({ facts, chat, mail });
    preambleCache.set(userId, { signature, value });
    return value;
  } catch (err) {
    if (__DEV__) console.warn('[profile] buildProfilePreamble failed:', err);
    return '';
  }
}
