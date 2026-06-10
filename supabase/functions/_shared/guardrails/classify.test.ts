import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseClassifierOutput, INPUT_RAIL_SYSTEM, OUTPUT_RAIL_SYSTEM } from './classify.ts';

Deno.test('parseClassifierOutput reads SAFE', () => {
  assertEquals(parseClassifierOutput('SAFE'), { verdict: 'safe', category: 'none' });
});

Deno.test('parseClassifierOutput reads UNSAFE with category', () => {
  assertEquals(parseClassifierOutput('UNSAFE: prompt_injection'), {
    verdict: 'unsafe',
    category: 'prompt_injection',
  });
});

Deno.test('parseClassifierOutput is case/space tolerant', () => {
  assertEquals(parseClassifierOutput('  unsafe : data_exfil  ').verdict, 'unsafe');
  assertEquals(parseClassifierOutput('Safe.').verdict, 'safe');
});

Deno.test('parseClassifierOutput fails safe on unrecognised text', () => {
  assertEquals(parseClassifierOutput('I think this is fine').verdict, 'unsafe');
  assertEquals(parseClassifierOutput('').verdict, 'unsafe');
});

Deno.test('prompts mention the required answer format', () => {
  assertEquals(INPUT_RAIL_SYSTEM.includes('SAFE'), true);
  assertEquals(OUTPUT_RAIL_SYSTEM.includes('SAFE'), true);
});
