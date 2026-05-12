import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isBudgetExceeded, BudgetSnapshot } from './budget.ts';

const limits = { dailyInput: 100_000, dailyOutput: 25_000 };

Deno.test('isBudgetExceeded: empty snapshot is fine', () => {
  const snap: BudgetSnapshot = { inputTokens: 0, outputTokens: 0 };
  assertEquals(isBudgetExceeded(snap, limits), false);
});

Deno.test('isBudgetExceeded: hits the input ceiling', () => {
  const snap: BudgetSnapshot = { inputTokens: 100_000, outputTokens: 0 };
  assertEquals(isBudgetExceeded(snap, limits), true);
});

Deno.test('isBudgetExceeded: hits the output ceiling', () => {
  const snap: BudgetSnapshot = { inputTokens: 0, outputTokens: 25_000 };
  assertEquals(isBudgetExceeded(snap, limits), true);
});

Deno.test('isBudgetExceeded: under both is fine', () => {
  const snap: BudgetSnapshot = { inputTokens: 99_999, outputTokens: 24_999 };
  assertEquals(isBudgetExceeded(snap, limits), false);
});
