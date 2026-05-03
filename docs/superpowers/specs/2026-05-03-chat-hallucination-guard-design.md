# Chat hallucination guard — design

**Date:** 2026-05-03
**Status:** approved (pending implementation plan)

## Problem

The Zolva chat (`useChat` in `src/lib/hooks.ts`) wires Claude to a tool-calling loop with read and write tools across mail, calendar, reminders, notes, and Drive. The model occasionally returns a text-only response that *claims* it performed an action — "Jeg har sendt mailen", "Jeg har lagt det i kalenderen" — without ever emitting a `tool_use` block. The user has confirmed the failure mode end-to-end: the assistant says it sent a mail, the user calls it out, the assistant acknowledges it didn't send anything and then sends it.

System-prompt rules in `buildChatSystemPrompt` (`hooks.ts:2389-2477`) already tell the model "Kald værktøjer FØR du bekræfter" and require explicit user confirmation for sends. The model breaks these rules anyway. A prompt-only fix is insufficient.

## Goal

Backstop the prompt with a deterministic guard that catches text-only responses claiming a tool-backed action, and forces the model to either actually call the tool or correct itself before the user sees the message.

## Non-goals

- Diff claimed actions against actually-called tools (partial-truth detection).
- Per-user telemetry, analytics, dashboards. Dev-only console logs.
- Tuning thresholds or confidence scores. Binary claimed yes/no.
- Replacing existing system-prompt guidance. The prompt stays; the guard is a backstop.
- Caching classifier verdicts across turns.

## Architecture

New module `src/lib/chat-claim-guard.ts` exports one function:

```ts
export type ChatToolName =
  | 'send_mail' | 'create_draft'
  | 'add_reminder' | 'add_note'
  | 'create_calendar_event' | 'update_calendar_event' | 'delete_calendar_event'
  | 'list_calendar_events' | 'list_recent_mail' | 'read_mail_thread'
  | 'list_reminders' | 'list_notes'
  | 'search_drive_files' | 'read_drive_file';

export type ClaimVerdict = {
  claimed: boolean;
  tool: ChatToolName | null;
  reason: string;
};

export async function classifyClaim(
  assistantText: string,
  signal?: AbortSignal,
): Promise<ClaimVerdict>;
```

Internally calls `completeJson` from `src/lib/claude.ts` with:
- Model: Haiku (default) — explicit, not relying on `DEFAULT_MODEL`
- `temperature: 0`
- `maxTokens: 150`
- `attachProfile: false` (no memory needed for a meta-classifier; saves cache + tokens)
- `signal` plumbed through

The guard is invoked from `runTurn` in `useChat` (`hooks.ts:3210-3242`). Guard logic stays out of `claude.ts` — the proxy layer remains generic; this is chat-specific.

## Loop integration

Replaces the existing `runTurn` body. New control flow:

```
working = toClaudeMessages(history)
correctionAttempted = false

for round in 0..CHAT_TOOL_ROUND_CAP:
    result = await completeRaw({ system, messages: working, tools: CHAT_TOOLS, metadata })

    if result.toolUses.length > 0:
        # Existing path — run tools, append, continue.
        working.push({ role: 'assistant', content: result.rawContent })
        toolResults = await Promise.all(result.toolUses.map(runChatTool))
        working.push({ role: 'user', content: toolResults })
        continue

    text = result.text.trim()
    toolUsedThisTurn = working.some(m =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some(b => b.type === 'tool_use')
    )

    if toolUsedThisTurn:
        # Final summary after a real tool call — grounded. Accept.
        return text

    claim = await classifyClaim(text, signal).catch(() => ({ claimed: false, tool: null, reason: 'classifier-failed' }))
    if !claim.claimed:
        return text

    if correctionAttempted:
        return GENERIC_CONFUSED_FALLBACK

    correctionAttempted = true
    working.push({ role: 'assistant', content: result.rawContent })
    working.push({ role: 'user', content: buildCorrectionMessage(claim.tool) })
    continue

return GENERIC_CONFUSED_FALLBACK
```

### Invariants

1. **Guard is skipped when any prior round in this turn used a tool.** A summary after a real `list_calendar_events` is grounded; we don't pay the classifier cost or risk a false positive on it.
2. **`correctionAttempted` is per-turn.** Max one corrective injection per user message.
3. **Classifier failure is fail-open.** Network error, malformed JSON, abort — all return `{claimed: false}` and the original text passes through. The guard never breaks chat on infra failure; worst case is the original (rare) hallucination.
4. **Existing `CHAT_TOOL_ROUND_CAP = 5` is unchanged.** The corrective round consumes a normal slot.

### Constants

```ts
const GENERIC_CONFUSED_FALLBACK =
  'Jeg blev forvirret — kan du gentage hvad du gerne vil have mig til?';

function buildCorrectionMessage(tool: ChatToolName | null): string {
  const toolPart = tool ? `'${tool}'` : 'et værktøj';
  return [
    `Du påstod at du har udført ${toolPart}, men du kaldte ikke værktøjet i din forrige tur.`,
    'Enten kald værktøjet nu hvis brugeren har bekræftet handlingen, eller spørg brugeren',
    'om bekræftelse før du fortsætter. Påstå aldrig at noget er udført uden faktisk at have',
    'kaldt værktøjet.',
  ].join(' ');
}
```

## Classifier prompt

System prompt (Danish, matches the chat's language):

```
Du er en intern klassifikator for en chatbot der har værktøjer til mail og kalender.
Du får én besked fra chatbotten. Afgør om beskeden påstår at en handling er udført
eller at konkrete data er hentet — ting der KRÆVER et værktøjskald.

Påstande der kræver værktøj (claimed=true):
- "Jeg har sendt mailen", "Mailen er afsendt", "Jeg sendte den"
- "Jeg har gemt udkastet", "Udkastet ligger i din kladdemappe"
- "Jeg har oprettet/ændret/slettet begivenheden", "Den er lagt i kalenderen"
- "Jeg har gemt påmindelsen/noten"
- "Jeg har tjekket din kalender — du har X", "Din næste mail er fra Y"
- "Jeg fandt filen om Z i Drive"

IKKE krav om værktøj (claimed=false):
- Spørgsmål til brugeren ("Skal jeg sende den?")
- Bekræftelse FØR handling ("Jeg sender den nu hvis du siger ja")
- Generel snak / hjælp / forklaring
- "Jeg KAN sende mails", "Jeg har værktøjer til..."
- Fremtidsform ("Jeg vil sende...", "Jeg sender...")
- Negationer ("Jeg har IKKE sendt den")
```

Schema hint passed to `completeJson`:

```
{
  "claimed": "boolean — true hvis beskeden påstår en udført handling",
  "tool": "string|null — én af: send_mail, create_draft, add_reminder, add_note, create_calendar_event, update_calendar_event, delete_calendar_event, list_calendar_events, list_recent_mail, read_mail_thread, list_reminders, list_notes, search_drive_files, read_drive_file. null hvis claimed=false eller værktøj uklart.",
  "reason": "string — kort dansk begrundelse, max 100 tegn"
}
```

User message: the assistant text to classify, verbatim.

### Read-tool catch criterion

For read tools, the criterion is "claims concrete data was retrieved" rather than "claims a tool was called":
- "you have a meeting at 3pm" → `claimed: true` (data claim)
- "let me check your calendar" → `claimed: false` (intent, not claim)

## Cost & latency profile per chat turn

| Scenario | Classifier calls | Extra latency | Cost |
|---|---|---|---|
| Tool called in round 1 | 0 | 0 | unchanged |
| Text-only, honest response | 1 | ~150-300ms | ~$0.0001 |
| Text-only, claim caught | 1 + 1 corrective Claude round | ~600ms-1.5s | ~$0.0001 + 1 turn |
| Correction also fails | 1 + 1 corrective + fallback string | bounded | bounded |

## Edge cases

1. **Multiple tools claimed** ("Jeg har sendt mailen og oprettet mødet") — classifier returns one `tool` field. The correction message is generic enough; the model gets nudged to call all needed tools or correct itself.
2. **Partial-truth claims** ("Jeg har sendt den til Lars og lagt det i kalenderen" but only `send_mail` ran) — guard only fires when *no* tool ran this turn (invariant 1), so this slips through. Known limitation. Detecting it would require diffing claims against actual tool calls — out of scope.
3. **Claim referring to a previous turn** ("Som jeg sagde før, har jeg sendt mailen") — classifier flags as claim → correction says "you didn't call the tool" → model can correctly respond "you're right, that was earlier." Slightly noisy, not harmful; correction wording explicitly allows "or correct yourself."
4. **Very short text** ("Ok.", "Klar.") — no claim, classifier returns false. Pass through.
5. **Malformed classifier JSON** — `completeJson` throws, caller catches, fail-open.
6. **User abort mid-turn** — `signal` plumbed through to the classifier call.

## Observability

When `__DEV__ && getPrivacyFlag('anon-reports')`:

```
[chat-guard] caught {tool}: "{first 80 chars of text}"
[chat-guard] correction failed, falling back
```

No production telemetry — matches the existing project pattern (no analytics SDK; `console.warn` gated on dev + privacy flag, e.g. `hooks.ts:3263`).

## Testing

High level (detailed test plan comes in writing-plans):

- **Unit tests** on `classifyClaim` against ~15 Danish fixture phrases:
  - True claims: 5 (one per write tool family + one read).
  - Negations: 2 ("ikke sendt", "har ikke gemt").
  - Future tense: 2 ("jeg sender", "jeg vil oprette").
  - Capability: 2 ("jeg kan sende", "jeg har værktøjer til").
  - Questions: 2 ("skal jeg sende?", "vil du have...").
  - Pre-action confirmations: 2 ("jeg sender hvis du siger ja").
- **Loop integration test** with mocked `completeRaw`: verify (a) guard skipped when tool was used; (b) honest text passes through; (c) caught claim triggers correction round; (d) second hallucination yields fallback.
- **Manual end-to-end**: trigger the original bug ("send Lars en mail om mødet") on a real account; verify the model either calls `create_draft` after correction or asks for confirmation, instead of falsely claiming it sent.

## Files touched

- **New:** `src/lib/chat-claim-guard.ts`
- **Modified:** `src/lib/hooks.ts` (the `runTurn` block in `useChat`, ~30 lines)
- **New tests:** `src/lib/__tests__/chat-claim-guard.test.ts` (matches the existing convention — `src/lib/__tests__/` is the project's test directory)
