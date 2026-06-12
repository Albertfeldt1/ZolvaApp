import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  clampMaxTokens,
  isAllowedModel,
  MAX_OUTPUT_TOKENS_CEILING,
} from './model-guard.ts';

Deno.test('isAllowedModel accepts the legit chat models', () => {
  assertEquals(isAllowedModel('claude-haiku-4-5-20251001'), true);
  assertEquals(isAllowedModel('claude-sonnet-4-6'), true); // current hard-turn model
  assertEquals(isAllowedModel('claude-opus-4-7'), true); // legacy, still accepted
});

Deno.test('isAllowedModel rejects unknown / spoofed models', () => {
  assertEquals(isAllowedModel('claude-opus-4-7-evil'), false);
  assertEquals(isAllowedModel('gpt-4'), false);
  assertEquals(isAllowedModel(''), false);
});

Deno.test('clampMaxTokens clamps oversized requests to the ceiling', () => {
  assertEquals(clampMaxTokens(32000, 1024), MAX_OUTPUT_TOKENS_CEILING);
  assertEquals(clampMaxTokens(1_000_000, 1024), MAX_OUTPUT_TOKENS_CEILING);
});

Deno.test('clampMaxTokens passes through valid in-range values', () => {
  assertEquals(clampMaxTokens(2000, 1024), 2000);
  assertEquals(clampMaxTokens(8192, 1024), 8192);
});

Deno.test('clampMaxTokens falls back on missing / invalid input', () => {
  assertEquals(clampMaxTokens(undefined, 1024), 1024);
  assertEquals(clampMaxTokens(0, 1024), 1024);
  assertEquals(clampMaxTokens(-5, 1024), 1024);
  assertEquals(clampMaxTokens('big', 1024), 1024);
});
