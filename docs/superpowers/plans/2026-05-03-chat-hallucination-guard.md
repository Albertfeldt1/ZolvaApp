# Chat Hallucination Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch text-only chat responses that falsely claim a tool-backed action ("Jeg har sendt mailen") and force one corrective round before the user sees the message.

**Architecture:** A new module `src/lib/chat-claim-guard.ts` exports `classifyClaim(text)` — a Haiku call via the existing `completeJson` proxy that returns `{claimed, tool, reason}`. The chat loop in `useChat` (`src/lib/hooks.ts`) consults the guard whenever a round returns text-only AND no tool was used earlier in the turn. On a caught claim, one correction message is injected; if the model still hallucinates, the user sees a generic fallback.

**Tech Stack:** TypeScript, React Native (Expo), `jest-expo` for tests, the project's existing `claude.ts` proxy (Haiku via `completeJson`).

**Reference spec:** `docs/superpowers/specs/2026-05-03-chat-hallucination-guard-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/chat-claim-guard.ts` | **NEW** | Exports `ChatToolName`, `ClaimVerdict`, `classifyClaim`, `buildCorrectionMessage`, `GENERIC_CONFUSED_FALLBACK`, `CHAT_GUARD_DEBUG_TAG`. ~100 lines. |
| `src/lib/__tests__/chat-claim-guard.test.ts` | **NEW** | Unit tests for `buildCorrectionMessage` (deterministic) and `classifyClaim` (with mocked `completeJson`). ~120 lines. |
| `src/lib/hooks.ts` | **MODIFY** | Replace the `runTurn` body inside `useChat` (lines ~3210-3242) to call the guard on text-only rounds. ~50 lines of net change. |

The guard module owns one responsibility: classify and label a single assistant message. The loop integration owns the orchestration. Splitting them keeps the classifier testable in isolation and the loop logic readable.

---

## Task 1: Scaffold guard module — types, constants, correction builder

**Files:**
- Create: `src/lib/chat-claim-guard.ts`
- Test: `src/lib/__tests__/chat-claim-guard.test.ts`

This task lands the static surface (types, constants, the pure `buildCorrectionMessage` helper) with TDD on the helper. `classifyClaim` is stubbed and lands fully in Task 2.

- [ ] **Step 1: Write the failing test for `buildCorrectionMessage`**

Create `src/lib/__tests__/chat-claim-guard.test.ts`:

```ts
// Mock supabase + AsyncStorage before importing anything that touches them.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));

import {
  buildCorrectionMessage,
  GENERIC_CONFUSED_FALLBACK,
} from '../chat-claim-guard';

describe('buildCorrectionMessage', () => {
  it('names the tool when known', () => {
    const out = buildCorrectionMessage('send_mail');
    expect(out).toContain("'send_mail'");
    expect(out).toContain('kaldte ikke værktøjet');
    expect(out).toContain('Påstå aldrig');
  });

  it('falls back to generic phrasing when tool is null', () => {
    const out = buildCorrectionMessage(null);
    expect(out).toContain('et værktøj');
    expect(out).not.toContain("''");
  });
});

describe('GENERIC_CONFUSED_FALLBACK', () => {
  it('is a non-empty Danish sentence', () => {
    expect(GENERIC_CONFUSED_FALLBACK.length).toBeGreaterThan(20);
    expect(GENERIC_CONFUSED_FALLBACK).toMatch(/forvirret|gentage/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/albertfeldt/ZolvaApp
npx jest src/lib/__tests__/chat-claim-guard.test.ts
```

Expected: FAIL — "Cannot find module '../chat-claim-guard'".

- [ ] **Step 3: Create the guard module with types, constants, and correction builder**

Create `src/lib/chat-claim-guard.ts`:

```ts
// Catches text-only chat responses that falsely claim a tool-backed action
// was performed. See docs/superpowers/specs/2026-05-03-chat-hallucination-
// guard-design.md for the full design.

import { completeJson } from './claude';
import { getPrivacyFlag } from './hooks';

export type ChatToolName =
  | 'send_mail'
  | 'create_draft'
  | 'add_reminder'
  | 'add_note'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'delete_calendar_event'
  | 'list_calendar_events'
  | 'list_recent_mail'
  | 'read_mail_thread'
  | 'list_reminders'
  | 'list_notes'
  | 'search_drive_files'
  | 'read_drive_file';

export type ClaimVerdict = {
  claimed: boolean;
  tool: ChatToolName | null;
  reason: string;
};

export const GENERIC_CONFUSED_FALLBACK =
  'Jeg blev forvirret — kan du gentage hvad du gerne vil have mig til?';

export const CHAT_GUARD_DEBUG_TAG = '[chat-guard]';

const VALID_TOOLS: ReadonlySet<ChatToolName> = new Set([
  'send_mail',
  'create_draft',
  'add_reminder',
  'add_note',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'list_calendar_events',
  'list_recent_mail',
  'read_mail_thread',
  'list_reminders',
  'list_notes',
  'search_drive_files',
  'read_drive_file',
]);

export function buildCorrectionMessage(tool: ChatToolName | null): string {
  const toolPart = tool ? `'${tool}'` : 'et værktøj';
  return [
    `Du påstod at du har udført ${toolPart}, men du kaldte ikke værktøjet i din forrige tur.`,
    'Enten kald værktøjet nu hvis brugeren har bekræftet handlingen, eller spørg brugeren',
    'om bekræftelse før du fortsætter. Påstå aldrig at noget er udført uden faktisk at have',
    'kaldt værktøjet.',
  ].join(' ');
}

export async function classifyClaim(
  _assistantText: string,
  _signal?: AbortSignal,
): Promise<ClaimVerdict> {
  // Implemented in Task 2.
  return { claimed: false, tool: null, reason: 'unimplemented' };
}

// Keep referenced symbols used so the linter doesn't flag them before Task 2
// wires them in: completeJson and getPrivacyFlag are used by classifyClaim.
void completeJson;
void getPrivacyFlag;
void VALID_TOOLS;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx jest src/lib/__tests__/chat-claim-guard.test.ts
```

Expected: PASS — three tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-claim-guard.ts src/lib/__tests__/chat-claim-guard.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-guard): scaffold module — types, constants, correction builder

Adds the static surface for the chat hallucination guard. classifyClaim
is stubbed; the real Haiku-backed implementation lands in the next commit.

Spec: docs/superpowers/specs/2026-05-03-chat-hallucination-guard-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement `classifyClaim` (Haiku JSON call + tests)

**Files:**
- Modify: `src/lib/chat-claim-guard.ts`
- Test: `src/lib/__tests__/chat-claim-guard.test.ts`

This task replaces the stub with a real Haiku call via `completeJson`, validates the response, and adds a fixture-driven test suite covering the cases in the spec.

- [ ] **Step 1: Write the failing tests for `classifyClaim`**

Append to `src/lib/__tests__/chat-claim-guard.test.ts`:

```ts
// Mock the claude proxy so classifyClaim is testable without a real Anthropic call.
jest.mock('../claude', () => ({
  completeJson: jest.fn(),
}));
// getPrivacyFlag is used for dev logging; safe default is "off".
jest.mock('../hooks', () => ({
  getPrivacyFlag: jest.fn(() => false),
}));

import { classifyClaim } from '../chat-claim-guard';
import { completeJson } from '../claude';

const mockedCompleteJson = completeJson as jest.MockedFunction<typeof completeJson>;

describe('classifyClaim', () => {
  beforeEach(() => {
    mockedCompleteJson.mockReset();
  });

  it('forwards the model verdict for a true claim', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: true,
      tool: 'send_mail',
      reason: 'siger "jeg har sendt"',
    });
    const v = await classifyClaim('Jeg har sendt mailen til Lars.');
    expect(v).toEqual({
      claimed: true,
      tool: 'send_mail',
      reason: 'siger "jeg har sendt"',
    });
  });

  it('returns false for honest non-action text', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: false,
      tool: null,
      reason: 'spørgsmål til brugeren',
    });
    const v = await classifyClaim('Skal jeg sende den nu?');
    expect(v.claimed).toBe(false);
    expect(v.tool).toBeNull();
  });

  it('coerces unknown tool names to null while preserving claimed=true', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: true,
      tool: 'totally_made_up_tool',
      reason: 'modellen opfandt et navn',
    });
    const v = await classifyClaim('Jeg har gjort noget uklart.');
    expect(v.claimed).toBe(true);
    expect(v.tool).toBeNull();
  });

  it('passes the supplied AbortSignal through to completeJson', async () => {
    const ctrl = new AbortController();
    mockedCompleteJson.mockResolvedValueOnce({ claimed: false, tool: null, reason: '' });
    await classifyClaim('hej', ctrl.signal);
    expect(mockedCompleteJson).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it('disables profile attachment to keep the classifier context clean', async () => {
    mockedCompleteJson.mockResolvedValueOnce({ claimed: false, tool: null, reason: '' });
    await classifyClaim('hej');
    expect(mockedCompleteJson).toHaveBeenCalledWith(
      expect.objectContaining({ attachProfile: false, temperature: 0 }),
    );
  });

  it('fails open when completeJson throws', async () => {
    mockedCompleteJson.mockRejectedValueOnce(new Error('network down'));
    const v = await classifyClaim('Jeg har sendt mailen.');
    expect(v).toEqual({
      claimed: false,
      tool: null,
      reason: 'classifier-failed',
    });
  });

  it('fails open when the response shape is malformed', async () => {
    // claimed missing entirely
    mockedCompleteJson.mockResolvedValueOnce({ tool: 'send_mail' } as any);
    const v = await classifyClaim('Jeg har sendt mailen.');
    expect(v.claimed).toBe(false);
    expect(v.reason).toBe('classifier-failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx jest src/lib/__tests__/chat-claim-guard.test.ts
```

Expected: 7 new tests FAIL (the stub returns the same value regardless of input/mock).

- [ ] **Step 3: Implement `classifyClaim`**

Replace the stub in `src/lib/chat-claim-guard.ts`. The full file becomes:

```ts
import { completeJson } from './claude';
import { getPrivacyFlag } from './hooks';

export type ChatToolName =
  | 'send_mail'
  | 'create_draft'
  | 'add_reminder'
  | 'add_note'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'delete_calendar_event'
  | 'list_calendar_events'
  | 'list_recent_mail'
  | 'read_mail_thread'
  | 'list_reminders'
  | 'list_notes'
  | 'search_drive_files'
  | 'read_drive_file';

export type ClaimVerdict = {
  claimed: boolean;
  tool: ChatToolName | null;
  reason: string;
};

export const GENERIC_CONFUSED_FALLBACK =
  'Jeg blev forvirret — kan du gentage hvad du gerne vil have mig til?';

export const CHAT_GUARD_DEBUG_TAG = '[chat-guard]';

const VALID_TOOLS: ReadonlySet<ChatToolName> = new Set([
  'send_mail',
  'create_draft',
  'add_reminder',
  'add_note',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'list_calendar_events',
  'list_recent_mail',
  'read_mail_thread',
  'list_reminders',
  'list_notes',
  'search_drive_files',
  'read_drive_file',
]);

const CLASSIFIER_SYSTEM = [
  'Du er en intern klassifikator for en chatbot der har værktøjer til mail og kalender.',
  'Du får én besked fra chatbotten. Afgør om beskeden påstår at en handling er udført',
  'eller at konkrete data er hentet — ting der KRÆVER et værktøjskald.',
  '',
  'Påstande der kræver værktøj (claimed=true):',
  '- "Jeg har sendt mailen", "Mailen er afsendt", "Jeg sendte den"',
  '- "Jeg har gemt udkastet", "Udkastet ligger i din kladdemappe"',
  '- "Jeg har oprettet/ændret/slettet begivenheden", "Den er lagt i kalenderen"',
  '- "Jeg har gemt påmindelsen/noten"',
  '- "Jeg har tjekket din kalender — du har X", "Din næste mail er fra Y"',
  '- "Jeg fandt filen om Z i Drive"',
  '',
  'IKKE krav om værktøj (claimed=false):',
  '- Spørgsmål til brugeren ("Skal jeg sende den?")',
  '- Bekræftelse FØR handling ("Jeg sender den nu hvis du siger ja")',
  '- Generel snak / hjælp / forklaring',
  '- "Jeg KAN sende mails", "Jeg har værktøjer til..."',
  '- Fremtidsform ("Jeg vil sende...", "Jeg sender...")',
  '- Negationer ("Jeg har IKKE sendt den")',
].join('\n');

const CLASSIFIER_SCHEMA_HINT = [
  '{',
  '  "claimed": "boolean — true hvis beskeden påstår en udført handling",',
  '  "tool": "string|null — én af: send_mail, create_draft, add_reminder, add_note, create_calendar_event, update_calendar_event, delete_calendar_event, list_calendar_events, list_recent_mail, read_mail_thread, list_reminders, list_notes, search_drive_files, read_drive_file. null hvis claimed=false eller værktøj uklart.",',
  '  "reason": "string — kort dansk begrundelse, max 100 tegn"',
  '}',
].join('\n');

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

type RawVerdict = {
  claimed?: unknown;
  tool?: unknown;
  reason?: unknown;
};

export function buildCorrectionMessage(tool: ChatToolName | null): string {
  const toolPart = tool ? `'${tool}'` : 'et værktøj';
  return [
    `Du påstod at du har udført ${toolPart}, men du kaldte ikke værktøjet i din forrige tur.`,
    'Enten kald værktøjet nu hvis brugeren har bekræftet handlingen, eller spørg brugeren',
    'om bekræftelse før du fortsætter. Påstå aldrig at noget er udført uden faktisk at have',
    'kaldt værktøjet.',
  ].join(' ');
}

export async function classifyClaim(
  assistantText: string,
  signal?: AbortSignal,
): Promise<ClaimVerdict> {
  try {
    const raw = await completeJson<RawVerdict>({
      model: CLASSIFIER_MODEL,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: assistantText }],
      schemaHint: CLASSIFIER_SCHEMA_HINT,
      maxTokens: 150,
      temperature: 0,
      attachProfile: false,
      signal,
    });
    return normalizeVerdict(raw);
  } catch (err) {
    if (__DEV__ && getPrivacyFlag('anon-reports')) {
      // eslint-disable-next-line no-console
      console.warn(
        `${CHAT_GUARD_DEBUG_TAG} classifier failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return { claimed: false, tool: null, reason: 'classifier-failed' };
  }
}

function normalizeVerdict(raw: RawVerdict): ClaimVerdict {
  if (typeof raw?.claimed !== 'boolean') {
    return { claimed: false, tool: null, reason: 'classifier-failed' };
  }
  const toolStr = typeof raw.tool === 'string' ? raw.tool : null;
  const tool = toolStr && VALID_TOOLS.has(toolStr as ChatToolName)
    ? (toolStr as ChatToolName)
    : null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  return { claimed: raw.claimed, tool, reason };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest src/lib/__tests__/chat-claim-guard.test.ts
```

Expected: All 9 tests PASS (2 from Task 1 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/chat-claim-guard.ts src/lib/__tests__/chat-claim-guard.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-guard): implement classifyClaim — Haiku-backed verdict

Calls completeJson with a Danish classifier prompt that flags assistant
messages claiming a tool-backed action was performed. Validates the
response shape, coerces unknown tool names to null, and fails open on
any error so the chat is never broken by classifier infra failures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire the guard into the chat loop

**Files:**
- Modify: `src/lib/hooks.ts:3210-3242` (the `runTurn` body inside `useChat`)

This task replaces the existing tool-call loop with a guarded version. There is no clean unit-test boundary for this hook (it owns React state and calls many providers), so verification is manual end-to-end in Task 4. Read the design's "Loop integration" section before editing.

- [ ] **Step 1: Add the guard imports near the top of `src/lib/hooks.ts`**

Find the existing imports at the top of `src/lib/hooks.ts`. Add a new import line alongside the other `./chat-*` imports (the file currently imports from `./chat-tools` around line 79):

```ts
import {
  buildCorrectionMessage,
  classifyClaim,
  GENERIC_CONFUSED_FALLBACK,
  CHAT_GUARD_DEBUG_TAG,
} from './chat-claim-guard';
```

- [ ] **Step 2: Replace the `runTurn` body**

Find the existing `runTurn` definition inside `useChat` at `src/lib/hooks.ts:3210-3242`. The current code looks like this (verify before editing — line numbers may shift):

```ts
const runTurn = async (): Promise<string> => {
  const working: ClaudeMessage[] = toClaudeMessages(nextHistory);
  for (let round = 0; round < CHAT_TOOL_ROUND_CAP; round += 1) {
    const result = await completeRaw({
      system: buildChatSystemPrompt(name),
      messages: working,
      tools: CHAT_TOOLS,
      metadata,
    });
    if (result.toolUses.length === 0) {
      return result.text.trim();
    }
    working.push({ role: 'assistant', content: result.rawContent });
    const toolCtx: ChatCtx = {
      userId: userId ?? null,
      hasGoogle: !!googleAccessToken,
      hasMicrosoft: !!microsoftAccessToken,
    };
    const toolResults = await Promise.all(
      result.toolUses.map(async (t) => {
        const r = await runChatTool(t.name, t.input, toolCtx);
        return {
          type: 'tool_result' as const,
          tool_use_id: t.id,
          content: r.content,
          is_error: r.isError,
        };
      }),
    );
    working.push({ role: 'user', content: toolResults });
  }
  return 'Jeg nåede ikke frem til et svar. Prøv igen?';
};
```

Replace it with the guarded version:

```ts
const runTurn = async (): Promise<string> => {
  const working: ClaudeMessage[] = toClaudeMessages(nextHistory);
  let correctionAttempted = false;
  const toolCtx: ChatCtx = {
    userId: userId ?? null,
    hasGoogle: !!googleAccessToken,
    hasMicrosoft: !!microsoftAccessToken,
  };

  for (let round = 0; round < CHAT_TOOL_ROUND_CAP; round += 1) {
    const result = await completeRaw({
      system: buildChatSystemPrompt(name),
      messages: working,
      tools: CHAT_TOOLS,
      metadata,
    });

    if (result.toolUses.length > 0) {
      working.push({ role: 'assistant', content: result.rawContent });
      const toolResults = await Promise.all(
        result.toolUses.map(async (t) => {
          const r = await runChatTool(t.name, t.input, toolCtx);
          return {
            type: 'tool_result' as const,
            tool_use_id: t.id,
            content: r.content,
            is_error: r.isError,
          };
        }),
      );
      working.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = result.text.trim();
    const toolUsedThisTurn = working.some(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_use'),
    );

    if (toolUsedThisTurn) {
      // Final summary after a real tool call — grounded by tool_result.
      return text;
    }

    const claim = await classifyClaim(text);
    if (!claim.claimed) {
      return text;
    }

    if (correctionAttempted) {
      if (__DEV__ && getPrivacyFlag('anon-reports')) {
        console.warn(`${CHAT_GUARD_DEBUG_TAG} correction failed, falling back`);
      }
      return GENERIC_CONFUSED_FALLBACK;
    }

    if (__DEV__ && getPrivacyFlag('anon-reports')) {
      console.warn(
        `${CHAT_GUARD_DEBUG_TAG} caught ${claim.tool ?? 'unknown'}: "${text.slice(0, 80)}"`,
      );
    }

    correctionAttempted = true;
    working.push({ role: 'assistant', content: result.rawContent });
    working.push({ role: 'user', content: buildCorrectionMessage(claim.tool) });
  }

  return GENERIC_CONFUSED_FALLBACK;
};
```

Notes on the diff:
- `toolCtx` is hoisted out of the loop body so the corrective round still has access if the model decides to call a tool. Behavior unchanged for the existing path.
- The "tool used earlier this turn" check inspects `working` for any assistant message with a `tool_use` block.
- The round-cap exhausted message changed from `'Jeg nåede ikke frem til et svar. Prøv igen?'` to `GENERIC_CONFUSED_FALLBACK` for consistency with the corrective path.

- [ ] **Step 3: Type-check the file**

```bash
cd /Users/albertfeldt/ZolvaApp
npx tsc --noEmit
```

Expected: PASS — no new TypeScript errors. (The repo may already have pre-existing errors; verify the file you edited isn't in the new error list.)

- [ ] **Step 4: Run the existing test suite to confirm no regressions**

```bash
npm test -- --watchAll=false
```

Expected: All tests PASS (existing `reminders.test.ts`, `widget-snapshot.test.ts`, plus the new `chat-claim-guard.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hooks.ts
git commit -m "$(cat <<'EOF'
feat(chat): wire claim guard into useChat run loop

Text-only rounds with no prior tool use now go through classifyClaim.
A caught hallucination triggers one corrective round; if the model still
claims an action without calling the tool, the user sees a generic
fallback instead of the lie.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual end-to-end verification

**Files:** none modified — this task validates the integrated behavior on a dev build.

The unit tests cover the classifier in isolation and the helpers. The loop integration has no automated test (it's a hook with React state + provider tokens), so we verify it by reproducing the original bug and confirming the guard catches it.

- [ ] **Step 1: Boot the dev build and sign in as the primary test account**

```bash
cd /Users/albertfeldt/ZolvaApp
npx expo start --clear
```

Sign in as `albertfeldt1@gmail.com` (the primary test account; `feldten@me.com` is the CC user, not an app user — see `user_test_accounts.md`). Confirm Gmail is connected (the `send_mail` / `create_draft` tools require it).

- [ ] **Step 2: Trigger the original bug and confirm the guard catches it**

In the chat, send the same kind of message that historically produced the hallucination:

```
Send Lars en mail om at vi rykker mødet til kl. 14
```

The model used to reply "Jeg har sendt mailen!" without calling `send_mail`. With the guard:
- **Best case:** the model calls `create_draft` directly and reports the draft ID. ✅
- **Acceptable:** the model returns text claiming the send, the guard catches it, the corrective round either calls the tool or asks for confirmation. The user sees only the corrected message. ✅
- **Failure mode to flag:** the message claims "Jeg har sendt mailen!" but no draft/send actually happened on the Gmail side, AND no `[chat-guard] caught` log appears. That means the guard didn't fire — bug.

Check the dev console for either:
```
[chat-guard] caught send_mail: "Jeg har sendt mailen..."
```
or no guard log at all (meaning the model did the right thing).

Verify in Gmail: a draft (or sent mail) should exist if the model claims one. If the chat ends with "Jeg blev forvirret...", the guard fired the fallback after a failed correction — also a successful outcome (no lie reached the user).

- [ ] **Step 3: Sanity-check the read-tool happy path**

Send:
```
Hvad har jeg i kalenderen i dag?
```

Expected: the model calls `list_calendar_events` (tool_use round), then summarises. The guard should be **skipped** for the summary because `toolUsedThisTurn` is true. No `[chat-guard]` log should appear. Verify the chat replies with calendar data without extra latency.

- [ ] **Step 4: Sanity-check an honest text-only response**

Send:
```
Hej Zolva, hvad kan du hjælpe mig med?
```

Expected: the model returns a capability description ("Jeg kan…"). The guard runs the classifier, classifier returns `claimed: false`, message passes through. One extra Haiku call worth of latency (~150-300ms) — should be barely perceptible.

- [ ] **Step 5: If all three checks pass, no further commits — close out**

The implementation is complete. If the manual checks turn up issues, file them as follow-up work; do not amend the existing commits.

```bash
git log --oneline -5
```

Expected to see, top-to-bottom:
- `feat(chat): wire claim guard into useChat run loop`
- `feat(chat-guard): implement classifyClaim — Haiku-backed verdict`
- `feat(chat-guard): scaffold module — types, constants, correction builder`
- `docs(chat): design — hallucination guard for chat tool calls`

---

## Self-review notes (writer's checklist — not for the executor)

- [x] **Spec coverage:** All sections of `2026-05-03-chat-hallucination-guard-design.md` map to a task — module surface and types (Task 1), classifier prompt + cost shape + edge cases 5/6 (Task 2), loop integration + invariants 1-4 + observability + edge cases 1/3/4 (Task 3), end-to-end verification (Task 4). Edge case 2 (partial-truth) is documented in the spec as a known limitation; no task is needed.
- [x] **Type consistency:** `ChatToolName` enum identical across module and tests; `ClaimVerdict` shape identical in mock fixtures and implementation; tool-name list in `VALID_TOOLS` matches `CHAT_TOOLS` registrations in `hooks.ts` (verified against grep output: 14/14).
- [x] **No placeholders:** Every code step shows the full code; every command shows expected output.
