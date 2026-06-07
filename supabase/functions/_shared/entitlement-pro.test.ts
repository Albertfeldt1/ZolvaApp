import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { keepProUsers } from './entitlement-pro.ts';

const users = [
  { userId: 'a', timezone: 'Europe/Copenhagen' },
  { userId: 'b', timezone: 'Europe/Copenhagen' },
  { userId: 'c', timezone: 'Europe/Copenhagen' },
];

Deno.test('keeps only users in the pro set', () => {
  const pro = new Set(['a', 'c']);
  assertEquals(keepProUsers(users, pro).map((u) => u.userId), ['a', 'c']);
});

Deno.test('missing from the set = excluded (free baseline)', () => {
  assertEquals(keepProUsers(users, new Set<string>()).length, 0);
});
