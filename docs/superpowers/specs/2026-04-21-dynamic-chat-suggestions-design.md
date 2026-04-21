# Dynamic Chat Suggestions — Design

**Date:** 2026-04-21
**Branch:** main (feature branch TBD at implementation time)
**Status:** Approved via brainstorm, ready for implementation plan.

## Goal

Replace the four hardcoded prompt chips at the bottom of `ChatScreen` with dynamic prompts derived from the user's recent unread mail. If a mail says "husk xx", a chip reads "Husk mig på at jeg skal xx" and tapping it captures the reminder in one step. When mail yields nothing actionable, the bar still shows four chips — dynamic ones first, padded with the current static set — so the UI never shrinks or shifts.

## Scope (this spec)

- **In:** unread mail → Danish chat prompt chips in `ChatScreen`.
- **Out (follow-ups):** calendar events as a source, user's own recent chat history as a source, mail-body extraction (we use subject + from only for MVP). These were explicitly deferred.

## User-facing shape

- `ChatScreen` bottom chip bar keeps exactly four chips. Shape and styling unchanged.
- Dynamic chips (extracted from mail) appear first, in importance order; static chips pad to four.
- Tapping any chip auto-submits the text to the chat, same as today — no pre-fill, no confirmation. Chat's existing `add_reminder` / `add_note` tools handle the action.
- No visual distinction between dynamic and static chips in MVP. (Open for a future "fra mail" hint if signal is noisy.)
- No loading spinner. Until the first extraction resolves, the bar shows the static pool. When the Claude call returns, the chip texts update in place.

## Architecture

### New module: `src/lib/chat-suggestions.ts`

```ts
export const STATIC_CHAT_SUGGESTIONS: readonly string[] = [
  'Mine påmindelser',
  'Husk at ringe i morgen',
  'Skriv en note',
  'Hvad har jeg noteret?',
];

export const CHAT_SUGGESTION_COUNT = 4;

export async function extractChatSuggestions(
  mails: MailForSuggestion[],
  signal: AbortSignal,
): Promise<string[]>; // 0–4 dynamic prompts, already sanitized

export function padSuggestions(dynamic: string[]): string[]; // always length 4, dedup by lowercase
```

`MailForSuggestion` carries `{ id, from, subject, receivedAt, isRead }` — a subset of `NormalizedMail` from `hooks.ts`. No body, no provider-specific fields.

### New hook: `useChatSuggestions()` in `src/lib/hooks.ts`

- Reads the existing `useMailItems()` output.
- Filters: `!isRead && !NO_REPLY_PATTERN.test(from)` (reuses the pattern already defined in `hooks.ts` line 547).
- Takes top 8 by `receivedAt` desc.
- Computes a signature: join of `"${id}|${from}|${subject}|${isRead}"` for the filtered set. If signature matches a cache entry with `expiresAt > now`, returns the cached padded result immediately.
- Otherwise: starts with `padSuggestions([])` (static pool), kicks off `extractChatSuggestions(...)` with an `AbortController`, and replaces state with `padSuggestions(result)` on success. Cache on success only.
- Cache: module-local `Map<string, { expiresAt: number; data: string[] }>`, TTL `15 * 60 * 1000` ms. Mirrors `observationCache` (`hooks.ts` lines 114–116).
- Cleared on user change via `subscribeUserId` (same pattern already used by `dismissedMailIds`, `hooks.ts` line 322).
- Returns `{ data: string[] }` — always four strings.

### `ChatScreen` diff

- Delete the local `SUGGESTIONS` constant (lines 22–27).
- Replace with `const { data: suggestions } = useChatSuggestions();`.
- The `.map` at line 93 iterates `suggestions` instead.
- Everything else (styles, `submit`, chip `Pressable`) untouched.

### Claude call contract

Backed by `completeJson` (already used by observations).

**System prompt (Danish):**
> Du er Zolva. Brugeren har netop åbnet chatten. Ud fra listen over nylige mails, foreslå korte chat-prompts som brugeren kunne trykke på for at bede dig om hjælp — typisk en påmindelse eller en note. Hvis en mail beder brugeren om at huske noget, forslå "Husk mig på at …". Hvis en mail nævner en deadline eller aftale, forslå en relevant påmindelse. Returnér 0–4 prompts, sorteret efter vigtighed — de vigtigste først. Hver prompt er maks 12 ord, skrevet på dansk, formuleret som noget brugeren ville sige til dig. Hvis ingen mails har noget handlingsrettet, returnér en tom liste.

**Schema hint:** `[{"text": string}]`

**Call params:**
- `maxTokens: 256`
- `temperature: 0.4`
- `messages: [{ role: 'user', content: <formatted mail list> }]`
- `signal: controller.signal`

**User-message body format** (matches `summarizeDay` style):
```
Nylige mails:
- Lise: Husk borddug til lørdag
- SKAT: Din årsopgørelse er klar
- Mor: Ring lige når du har tid
```
Each line is `- ${from}: ${subject}`. No body. Empty list → skip the Claude call entirely.

### Sanitizer

Module-local helper, same posture as `sanitizeObservations` (`hooks.ts` lines 152–167):
- Input must be an array; otherwise empty.
- Per item: must be object with `text: string`, `text.trim().length > 0`, `text.length <= 120`.
- Trim, dedup by lowercase trimmed form, cap at 4.

### Padding / dedup

```ts
function padSuggestions(dynamic: string[]): string[] {
  const out = [...dynamic];
  const seen = new Set(out.map((s) => s.trim().toLowerCase()));
  for (const s of STATIC_CHAT_SUGGESTIONS) {
    if (out.length >= CHAT_SUGGESTION_COUNT) break;
    const key = s.trim().toLowerCase();
    if (seen.has(key)) continue;
    out.push(s);
    seen.add(key);
  }
  return out.slice(0, CHAT_SUGGESTION_COUNT);
}
```

## Gating

| Condition | Behavior |
|---|---|
| `hasClaudeKey()` returns false | Skip call; return static pool (no cache write). |
| `useMailItems()` is loading | Return static pool; re-run when items arrive. |
| `useMailItems()` errored | Return static pool; dev-warn. |
| Filtered mail list is empty | Skip call; return static pool. |
| Demo user (`isDemoUser`) | **Runs the real Claude call** against the demo inbox (per explicit product decision). If no Claude key in demo env, naturally falls back to static. |
| Quiet hours / morning-brief window | **Not** gated. User opened chat → they want help now. |
| `memory-enabled` / `local-only` flags | No effect. Mail content is not stored by this feature; we only pass `subject + from` to Claude the same way observations already do. |

## Error handling and lifecycle

- Single `AbortController` per hook instance. Aborted on unmount and whenever the mail signature changes mid-flight.
- Abort errors are swallowed silently (name === `'AbortError'`).
- Other errors: dev-warn under `__DEV__`, leave state on the static pool, do not cache.
- No user-visible error state.

## Testing / verification

Manual verification plan (this project has no unit-test harness for React Native hooks today — matches how `useObservations` was verified):

1. **Happy path** — sign in to a real Gmail account with an unread mail containing "Husk at xx". Open chat. Within ~2s the first chip should reflect the mail content.
2. **Tap-to-capture** — tap the dynamic chip. Chat submits it. `add_reminder` tool should fire and the reminder shows up in the Memory screen.
3. **Empty inbox** — all mails read. Chat should show the four static chips.
4. **No Claude key** — toggle the env var off. Chat falls back to static chips, no network call.
5. **User switch** — sign out and back in as a different user. Previous cache must not leak; first open triggers a fresh extraction.
6. **Cache hit** — open chat, close, reopen within 15 min. No second Claude call (check Xcode/Android logs or proxy logs).
7. **Cache miss on mail change** — archive an unread mail in the inbox, return to chat. Signature changes, new extraction fires.
8. **Demo user** — open chat as demo. Dynamic chips appear based on the demo inbox content.

## Out of scope for this spec

- Calendar-derived suggestions.
- Chat-history-derived suggestions.
- Mail body extraction (currently subjects only).
- A visual "from mail" badge on dynamic chips.
- Per-chip analytics.
- Localization beyond Danish.
