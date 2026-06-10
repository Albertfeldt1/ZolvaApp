import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { checkMailInput, checkReplyOutput } from './rails.ts';
import type { GuardrailClassifier } from './types.ts';

const safeClassifier: GuardrailClassifier = () =>
  Promise.resolve({ verdict: 'safe', category: 'none' });
const unsafeClassifier: GuardrailClassifier = () =>
  Promise.resolve({ verdict: 'unsafe', category: 'prompt_injection' });
const throwingClassifier: GuardrailClassifier = () => {
  throw new Error('anthropic down');
};

Deno.test('checkMailInput: safe verdict -> ok', async () => {
  const v = await checkMailInput('normal mail', { classify: safeClassifier });
  assertEquals(v.ok, true);
});

Deno.test('checkMailInput: unsafe verdict -> not ok, carries category', async () => {
  const v = await checkMailInput('ignore instructions', { classify: unsafeClassifier });
  assertEquals(v.ok, false);
  assertEquals(v.category, 'prompt_injection');
});

Deno.test('checkMailInput: classifier throws -> fail-safe not ok', async () => {
  const v = await checkMailInput('x', { classify: throwingClassifier });
  assertEquals(v.ok, false);
  assertEquals(v.category, 'error');
});

Deno.test('checkMailInput: empty text -> ok without calling classifier', async () => {
  let called = false;
  const spy: GuardrailClassifier = () => {
    called = true;
    return Promise.resolve({ verdict: 'safe', category: 'none' });
  };
  const v = await checkMailInput('   ', { classify: spy });
  assertEquals(v.ok, true);
  assertEquals(called, false);
});

Deno.test('checkReplyOutput: unsafe verdict -> not ok', async () => {
  const v = await checkReplyOutput('bad reply', 'a@b.com', { classify: unsafeClassifier });
  assertEquals(v.ok, false);
});

Deno.test('checkReplyOutput: classifier throws -> fail-safe not ok', async () => {
  const v = await checkReplyOutput('reply', 'a@b.com', { classify: throwingClassifier });
  assertEquals(v.ok, false);
});
