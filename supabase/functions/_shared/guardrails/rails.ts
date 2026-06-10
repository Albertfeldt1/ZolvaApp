import type { GuardrailClassifier, GuardrailVerdict } from './types.ts';
import { INPUT_RAIL_SYSTEM, OUTPUT_RAIL_SYSTEM } from './classify.ts';
import { fenceUntrusted } from './fence.ts';

export interface RailDeps {
  classify: GuardrailClassifier;
}

// Input rail: is this incoming email body safe for the agent to read/act on?
// Empty bodies are trivially safe (nothing to inject). Any classifier error is
// fail-safe -> not ok (caller taints the run, forcing propose).
export async function checkMailInput(text: string, deps: RailDeps): Promise<GuardrailVerdict> {
  if (!text.trim()) return { ok: true, category: 'none', reason: '' };
  try {
    const r = await deps.classify({
      system: INPUT_RAIL_SYSTEM,
      user: fenceUntrusted(text),
      surface: 'guardrail-input',
    });
    return {
      ok: r.verdict === 'safe',
      category: r.category,
      reason: r.verdict === 'safe' ? '' : `input rail: ${r.category}`,
    };
  } catch (e) {
    return { ok: false, category: 'error', reason: `input rail error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Output rail: is this drafted reply safe to auto-send? Empty text is treated
// as unsafe (nothing to send / unexpected). Classifier error is fail-safe.
export async function checkReplyOutput(
  text: string,
  recipient: string,
  deps: RailDeps,
): Promise<GuardrailVerdict> {
  if (!text.trim()) return { ok: false, category: 'empty', reason: 'output rail: empty reply' };
  try {
    const r = await deps.classify({
      system: OUTPUT_RAIL_SYSTEM,
      user: `Recipient: ${recipient}\nReply:\n${text}`,
      surface: 'guardrail-output',
    });
    return {
      ok: r.verdict === 'safe',
      category: r.category,
      reason: r.verdict === 'safe' ? '' : `output rail: ${r.category}`,
    };
  } catch (e) {
    return { ok: false, category: 'error', reason: `output rail error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
