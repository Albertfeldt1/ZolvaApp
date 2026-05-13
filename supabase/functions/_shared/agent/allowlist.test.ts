import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { hasRecipientHistory } from './allowlist.ts';

interface FakeQuery {
  selectArg: string;
  filters: Array<{ col: string; op: string; val: unknown }>;
  resolveWith: { count: number | null; error: Error | null };
}

function makeClient(q: FakeQuery) {
  return {
    from(_table: string) {
      return {
        select(arg: string, _opts?: unknown) {
          q.selectArg = arg;
          const self = this as unknown as {
            eq: (c: string, v: unknown) => unknown;
            gte: (c: string, v: unknown) => unknown;
            then: (cb: (r: unknown) => void) => Promise<void>;
          };
          self.eq = (c, v) => {
            q.filters.push({ col: c, op: 'eq', val: v });
            return self;
          };
          self.gte = (c, v) => {
            q.filters.push({ col: c, op: 'gte', val: v });
            return self;
          };
          self.then = (cb) => Promise.resolve(cb({ count: q.resolveWith.count, error: q.resolveWith.error }));
          return self;
        },
      };
    },
  };
}

Deno.test('hasRecipientHistory: returns true when count >= threshold', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 4, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'mor@example.dk',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, true);
  assertEquals(q.selectArg, 'id');
  assertEquals(q.filters.find((f) => f.col === 'user_id')?.val, 'u-1');
  assertEquals(q.filters.find((f) => f.col === 'provider_to')?.val, 'mor@example.dk');
});

Deno.test('hasRecipientHistory: returns false when count below threshold', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 2, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'stranger@example.com',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
});

Deno.test('hasRecipientHistory: returns false on db error (fail-safe)', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: null, error: new Error('boom') } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'x@example.com',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
});

Deno.test('hasRecipientHistory: case-insensitive address match', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 5, error: null } };
  const client = makeClient(q);
  await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'Mor@Example.DK',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(q.filters.find((f) => f.col === 'provider_to')?.val, 'mor@example.dk');
});

Deno.test('hasRecipientHistory: returns false for empty address', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: 99, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: '   ',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
  // Ensure we did NOT hit the DB for empty addresses.
  assertEquals(q.filters.length, 0);
});

Deno.test('hasRecipientHistory: returns false when db returns null count with no error', async () => {
  const q: FakeQuery = { selectArg: '', filters: [], resolveWith: { count: null, error: null } };
  const client = makeClient(q);
  const ok = await hasRecipientHistory(client as never, {
    userId: 'u-1',
    address: 'a@b.dk',
    threshold: 3,
    withinDays: 60,
  });
  assertEquals(ok, false);
});
