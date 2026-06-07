# Billing Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entitlement source of truth (free | lite | pro) for Zolva, readable client-side (UI) and server-side (the agent), synced from RevenueCat purchases via a webhook, plus a minimal dev purchase trigger to test the loop.

**Architecture:** RevenueCat is the billing provider. The client reads `customerInfo` directly for instant UI; a RevenueCat webhook upserts a `user_entitlements` table in Supabase that server code (`agent-tick`, chat) reads, because the agent runs on cron with no client. RevenueCat's `appUserID` is set to the Supabase `user.id` so purchases tie to the account. Absence of a row = `free`.

**Tech Stack:** RevenueCat (`react-native-purchases`), Expo SDK 54 dev build, Supabase Postgres + Deno edge functions, Deno tests (server) + Jest/jest-expo (client).

**Spec:** `docs/superpowers/specs/2026-06-07-billing-foundation-design.md`

**Commit/deploy order (project convention):** server changes (`supabase/**`) get their own commits and deploy FIRST, before any client commit. Do not `git add -A` — `app.json` carries an unrelated uncommitted local diff; stage files by explicit path. No AI attribution in commit messages. Do not push unless told.

---

## Prerequisites (ops — not code; do before Task 5+)

These are dashboard/console steps the human performs. Code tasks 1–4 (server) do not need them; tasks 5+ (client + e2e) do.

- [ ] Create a RevenueCat project; connect App Store Connect and Google Play Console.
- [ ] In App Store Connect / Play Console create 3 auto-renewable subscription products:
      `lite_monthly` (49 DKK/mo), `pro_monthly` (99 DKK/mo), `pro_yearly` (~990 DKK/yr).
      Add a **7-day free introductory offer** to `pro_monthly` and `pro_yearly` only.
- [ ] In RevenueCat: define entitlements **`pro`** (attach `pro_monthly`, `pro_yearly`) and **`lite`** (attach `lite_monthly`). Create an Offering (e.g. `default`) with packages for all three.
- [ ] Copy the RevenueCat **public SDK keys** (iOS + Android) and set them as build env:
      `EXPO_PUBLIC_RC_IOS_KEY`, `EXPO_PUBLIC_RC_ANDROID_KEY` (in `.env`, which is gitignored — also add to EAS secrets for builds).
- [ ] In RevenueCat → Integrations → Webhooks: set URL to
      `https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/revenuecat-webhook` and set an
      **Authorization header** value (a long random string). Store that same string as the Supabase secret in Task 4.

---

## Task 1: `user_entitlements` table migration

**Files:**
- Create: `supabase/migrations/20260607130000_user_entitlements.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260607130000_user_entitlements.sql
--
-- Billing foundation: server-side source of truth for a user's tier.
-- Synced from RevenueCat via the revenuecat-webhook edge function.
-- Absence of a row = 'free' baseline (no migration/backfill needed).
-- See spec 2026-06-07-billing-foundation-design.

create table if not exists public.user_entitlements (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  tier                text not null default 'free' check (tier in ('free','lite','pro')),
  is_trial            boolean not null default false,
  current_period_end  timestamptz,
  store               text,
  product_id          text,
  rc_app_user_id      text,
  updated_at          timestamptz not null default now(),
  raw_event           jsonb
);

alter table public.user_entitlements enable row level security;

-- Users read their own entitlement (drives client UI fallback / Settings).
create policy "owner-select-entitlement" on public.user_entitlements
  for select to authenticated
  using (auth.uid() = user_id);

-- No INSERT/UPDATE policy for authenticated -> writes are service-role only
-- (the webhook function). Clients never write entitlements.
```

- [ ] **Step 2: Apply the migration**

Run: `supabase db push`
Expected: migration `20260607130000_user_entitlements` applied with no error.

- [ ] **Step 3: Verify the table exists**

Run: `supabase db push --dry-run` (should report nothing pending) — or query via the Supabase MCP `list_tables` and confirm `user_entitlements` is present with the `tier` check constraint.
Expected: table present, RLS enabled, one SELECT policy.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260607130000_user_entitlements.sql
git commit -m "feat(billing): add user_entitlements table

- server-side source of truth for tier (free|lite|pro)
- RLS: owner select only; writes are service-role (webhook)
- absence of row = free baseline"
```

---

## Task 2: Server entitlement mapping (pure logic)

Pure functions mapping a RevenueCat webhook event → an entitlement outcome. No I/O, no Supabase import, fully unit-testable.

**Files:**
- Create: `supabase/functions/_shared/entitlement.ts`
- Test: `supabase/functions/_shared/entitlement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/entitlement.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tierFromEntitlementIds, eventToOutcome, rowToState } from './entitlement.ts';

Deno.test('tierFromEntitlementIds prefers pro over lite', () => {
  assertEquals(tierFromEntitlementIds(['lite', 'pro']), 'pro');
  assertEquals(tierFromEntitlementIds(['lite']), 'lite');
  assertEquals(tierFromEntitlementIds([]), 'free');
  assertEquals(tierFromEntitlementIds(null), 'free');
});

const UID = '5d9ef13e-7f5a-40b1-907b-31d0abb7e415';

Deno.test('INITIAL_PURCHASE on trial -> upsert pro is_trial true', () => {
  const out = eventToOutcome({
    type: 'INITIAL_PURCHASE', app_user_id: UID, entitlement_ids: ['pro'],
    period_type: 'TRIAL', expiration_at_ms: 1_700_000_000_000,
    store: 'APP_STORE', product_id: 'pro_monthly',
  });
  assertEquals(out, {
    action: 'upsert', userId: UID,
    state: {
      tier: 'pro', is_trial: true,
      current_period_end: new Date(1_700_000_000_000).toISOString(),
      store: 'APP_STORE', product_id: 'pro_monthly',
    },
  });
});

Deno.test('RENEWAL normal lite -> upsert lite is_trial false', () => {
  const out = eventToOutcome({
    type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['lite'],
    period_type: 'NORMAL', expiration_at_ms: null, store: 'PLAY_STORE', product_id: 'lite_monthly',
  });
  assertEquals(out.action, 'upsert');
  if (out.action === 'upsert') {
    assertEquals(out.state.tier, 'lite');
    assertEquals(out.state.is_trial, false);
    assertEquals(out.state.current_period_end, null);
  }
});

Deno.test('EXPIRATION -> expire', () => {
  assertEquals(
    eventToOutcome({ type: 'EXPIRATION', app_user_id: UID, entitlement_ids: ['pro'] }),
    { action: 'expire', userId: UID },
  );
});

Deno.test('CANCELLATION -> ignore (still entitled until expiration)', () => {
  const out = eventToOutcome({ type: 'CANCELLATION', app_user_id: UID, entitlement_ids: ['pro'] });
  assertEquals(out.action, 'ignore');
});

Deno.test('anonymous app_user_id -> ignore', () => {
  const out = eventToOutcome({
    type: 'INITIAL_PURCHASE', app_user_id: '$RCAnonymousID:abc', entitlement_ids: ['pro'],
  });
  assertEquals(out.action, 'ignore');
});

Deno.test('active event with unknown entitlement -> expire to free', () => {
  const out = eventToOutcome({ type: 'RENEWAL', app_user_id: UID, entitlement_ids: [] });
  assertEquals(out, { action: 'expire', userId: UID });
});

Deno.test('rowToState null -> free', () => {
  assertEquals(rowToState(null), {
    tier: 'free', is_trial: false, current_period_end: null, store: null, product_id: null,
  });
});

Deno.test('rowToState maps a row', () => {
  assertEquals(
    rowToState({ tier: 'pro', is_trial: true, current_period_end: '2026-01-01T00:00:00.000Z', store: 'APP_STORE', product_id: 'pro_monthly' }),
    { tier: 'pro', is_trial: true, current_period_end: '2026-01-01T00:00:00.000Z', store: 'APP_STORE', product_id: 'pro_monthly' },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test supabase/functions/_shared/entitlement.test.ts`
Expected: FAIL — `Module not found "./entitlement.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/entitlement.ts
//
// Pure mapping from RevenueCat webhook events / DB rows to a tier state.
// No I/O here so it stays unit-testable. See revenuecat-webhook for wiring.

export type Tier = 'free' | 'lite' | 'pro';

export type EntitlementState = {
  tier: Tier;
  is_trial: boolean;
  current_period_end: string | null; // ISO 8601
  store: string | null;
  product_id: string | null;
};

// Subset of RevenueCat webhook event fields we consume.
// https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
export type RcEvent = {
  type: string;
  app_user_id?: string;
  entitlement_ids?: string[] | null;
  period_type?: string;            // 'TRIAL' | 'INTRO' | 'NORMAL'
  expiration_at_ms?: number | null;
  store?: string;                  // 'APP_STORE' | 'PLAY_STORE' | 'PROMOTIONAL'
  product_id?: string;
};

export type WebhookOutcome =
  | { action: 'upsert'; userId: string; state: EntitlementState }
  | { action: 'expire'; userId: string }
  | { action: 'ignore'; reason: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Events that mean "user is currently entitled to whatever entitlement_ids says".
const ACTIVE_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'SUBSCRIPTION_EXTENDED',
]);

export function tierFromEntitlementIds(ids: string[] | null | undefined): Tier {
  const set = new Set(ids ?? []);
  if (set.has('pro')) return 'pro';
  if (set.has('lite')) return 'lite';
  return 'free';
}

export function eventToOutcome(event: RcEvent): WebhookOutcome {
  const userId = event.app_user_id ?? '';
  if (!UUID_RE.test(userId)) {
    return { action: 'ignore', reason: 'app_user_id is not a Supabase user id (anonymous?)' };
  }
  if (event.type === 'EXPIRATION') {
    return { action: 'expire', userId };
  }
  if (!ACTIVE_TYPES.has(event.type)) {
    // CANCELLATION = auto-renew off but still entitled until EXPIRATION.
    // BILLING_ISSUE = grace period. TRANSFER/TEST = irrelevant. No tier change.
    return { action: 'ignore', reason: `no tier change for ${event.type}` };
  }
  const tier = tierFromEntitlementIds(event.entitlement_ids);
  if (tier === 'free') {
    // Active event but no known entitlement -> treat as down to free.
    return { action: 'expire', userId };
  }
  return {
    action: 'upsert',
    userId,
    state: {
      tier,
      is_trial: event.period_type === 'TRIAL',
      current_period_end: event.expiration_at_ms
        ? new Date(event.expiration_at_ms).toISOString()
        : null,
      store: event.store ?? null,
      product_id: event.product_id ?? null,
    },
  };
}

// Maps a DB row (or null) to a full state. Used by getEntitlement (Task 3).
export function rowToState(row: Partial<EntitlementState> | null | undefined): EntitlementState {
  if (!row || !row.tier) {
    return { tier: 'free', is_trial: false, current_period_end: null, store: null, product_id: null };
  }
  return {
    tier: row.tier as Tier,
    is_trial: row.is_trial ?? false,
    current_period_end: row.current_period_end ?? null,
    store: row.store ?? null,
    product_id: row.product_id ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test supabase/functions/_shared/entitlement.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/entitlement.ts supabase/functions/_shared/entitlement.test.ts
git commit -m "feat(billing): RevenueCat event -> entitlement mapping

- tierFromEntitlementIds (pro > lite > free)
- eventToOutcome: upsert/expire/ignore per event type
- rowToState for the server reader"
```

---

## Task 3: Server `getEntitlement(userId)` reader

The reader sub-project #2 will gate on. Kept separate from the pure module so the Supabase import doesn't touch the unit tests.

**Files:**
- Create: `supabase/functions/_shared/entitlement-read.ts`

- [ ] **Step 1: Write the implementation**

```ts
// supabase/functions/_shared/entitlement-read.ts
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rowToState, type EntitlementState } from './entitlement.ts';

// Reads a user's tier from the source-of-truth table. Returns the free
// baseline when no row exists. Used by agent-tick / chat gating (sub-project #2).
export async function getEntitlement(
  client: SupabaseClient,
  userId: string,
): Promise<EntitlementState> {
  const { data } = await client
    .from('user_entitlements')
    .select('tier,is_trial,current_period_end,store,product_id')
    .eq('user_id', userId)
    .maybeSingle();
  return rowToState(data as Partial<EntitlementState> | null);
}
```

- [ ] **Step 2: Type-check the module**

Run: `deno check supabase/functions/_shared/entitlement-read.ts`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/entitlement-read.ts
git commit -m "feat(billing): getEntitlement server reader (free when no row)"
```

---

## Task 4: `revenuecat-webhook` edge function

Validates the shared Authorization secret, parses the event, and upserts/expires `user_entitlements`. The decision logic is extracted into `handleWebhook` for unit testing with fakes.

**Files:**
- Create: `supabase/functions/revenuecat-webhook/handler.ts`
- Create: `supabase/functions/revenuecat-webhook/handler.test.ts`
- Create: `supabase/functions/revenuecat-webhook/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/revenuecat-webhook/handler.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleWebhook, type WebhookDeps } from './handler.ts';

const UID = '5d9ef13e-7f5a-40b1-907b-31d0abb7e415';

function fakeDeps(): WebhookDeps & { upserts: unknown[]; expires: string[] } {
  const upserts: unknown[] = [];
  const expires: string[] = [];
  return {
    secret: 'shh',
    upserts, expires,
    upsert: async (userId, state) => { upserts.push({ userId, state }); },
    expire: async (userId) => { expires.push(userId); },
  };
}

Deno.test('rejects wrong auth header with 401', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('nope', { event: { type: 'RENEWAL', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 401);
  assertEquals(deps.upserts.length, 0);
});

Deno.test('upserts on a purchase event', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {
    event: { type: 'INITIAL_PURCHASE', app_user_id: UID, entitlement_ids: ['pro'], period_type: 'TRIAL', product_id: 'pro_monthly' },
  }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.upserts.length, 1);
  assertEquals(deps.expires.length, 0);
});

Deno.test('expires on EXPIRATION', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', { event: { type: 'EXPIRATION', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.expires, [UID]);
});

Deno.test('ignores cancellation without writing', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', { event: { type: 'CANCELLATION', app_user_id: UID, entitlement_ids: ['pro'] } }, deps);
  assertEquals(res.status, 200);
  assertEquals(deps.upserts.length, 0);
  assertEquals(deps.expires.length, 0);
});

Deno.test('400 when payload has no event', async () => {
  const deps = fakeDeps();
  const res = await handleWebhook('shh', {}, deps);
  assertEquals(res.status, 400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test supabase/functions/revenuecat-webhook/handler.test.ts`
Expected: FAIL — `Module not found "./handler.ts"`.

- [ ] **Step 3: Write the handler**

```ts
// supabase/functions/revenuecat-webhook/handler.ts
import { eventToOutcome, type EntitlementState, type RcEvent } from '../_shared/entitlement.ts';

export type WebhookDeps = {
  secret: string;
  upsert: (userId: string, state: EntitlementState, raw: unknown) => Promise<void>;
  expire: (userId: string, raw: unknown) => Promise<void>;
};

export type WebhookResult = { status: number; body: { ok: boolean; reason?: string } };

export async function handleWebhook(
  authHeader: string | null,
  payload: { event?: RcEvent } | null,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  if (!authHeader || authHeader !== deps.secret) {
    return { status: 401, body: { ok: false, reason: 'bad auth' } };
  }
  const event = payload?.event;
  if (!event || typeof event.type !== 'string') {
    return { status: 400, body: { ok: false, reason: 'no event' } };
  }
  const outcome = eventToOutcome(event);
  if (outcome.action === 'ignore') {
    return { status: 200, body: { ok: true, reason: outcome.reason } };
  }
  if (outcome.action === 'expire') {
    await deps.expire(outcome.userId, payload);
    return { status: 200, body: { ok: true } };
  }
  await deps.upsert(outcome.userId, outcome.state, payload);
  return { status: 200, body: { ok: true } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test supabase/functions/revenuecat-webhook/handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the HTTP entry point**

```ts
// supabase/functions/revenuecat-webhook/index.ts
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleWebhook } from './handler.ts';
import type { EntitlementState } from '../_shared/entitlement.ts';

function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  let payload: unknown = null;
  try { payload = await req.json(); } catch { payload = null; }

  const client = admin();
  const result = await handleWebhook(authHeader, payload as { event?: never } | null, {
    secret: Deno.env.get('REVENUECAT_WEBHOOK_SECRET') ?? '',
    upsert: async (userId, state: EntitlementState, raw) => {
      await client.from('user_entitlements').upsert({
        user_id: userId,
        tier: state.tier,
        is_trial: state.is_trial,
        current_period_end: state.current_period_end,
        store: state.store,
        product_id: state.product_id,
        rc_app_user_id: userId,
        updated_at: new Date().toISOString(),
        raw_event: raw,
      }, { onConflict: 'user_id' });
    },
    expire: async (userId, raw) => {
      await client.from('user_entitlements').upsert({
        user_id: userId,
        tier: 'free',
        is_trial: false,
        current_period_end: null,
        rc_app_user_id: userId,
        updated_at: new Date().toISOString(),
        raw_event: raw,
      }, { onConflict: 'user_id' });
    },
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/revenuecat-webhook/
git commit -m "feat(billing): revenuecat-webhook edge function

- shared-secret auth, parse event, upsert/expire user_entitlements
- handleWebhook extracted + unit tested with fakes"
```

- [ ] **Step 7: Set the webhook secret + deploy (server-first, per convention)**

Run (human, with the value chosen in Prerequisites):
```bash
supabase secrets set REVENUECAT_WEBHOOK_SECRET='<the-authorization-header-value>' --project-ref sjkhfkatmeqtsrysixop
supabase functions deploy revenuecat-webhook --no-verify-jwt --project-ref sjkhfkatmeqtsrysixop
```
Expected: deploy succeeds. `--no-verify-jwt` is required — this is a service-to-service call authenticated by the shared secret, not a user JWT, so the gateway must not reject it.

- [ ] **Step 8: Smoke-test the deployed webhook**

Run (replace SECRET):
```bash
curl -s -X POST 'https://sjkhfkatmeqtsrysixop.supabase.co/functions/v1/revenuecat-webhook' \
  -H 'Authorization: SECRET' -H 'content-type: application/json' \
  -d '{"event":{"type":"INITIAL_PURCHASE","app_user_id":"5d9ef13e-7f5a-40b1-907b-31d0abb7e415","entitlement_ids":["pro"],"period_type":"TRIAL","product_id":"pro_monthly","store":"APP_STORE","expiration_at_ms":1900000000000}}'
```
Expected: `{"ok":true}`. Then confirm via Supabase MCP `execute_sql`: a `user_entitlements` row for that user with `tier='pro'`, `is_trial=true`. **Clean up afterward** (`delete from user_entitlements where user_id='5d9ef13e-...'`) so the test user returns to free.

---

## Task 5: Install RevenueCat SDK + client purchases module

**Files:**
- Modify: `package.json` (via `expo install`)
- Create: `src/lib/purchases.ts`

- [ ] **Step 1: Install the SDK and rebuild the dev client**

Run:
```bash
npx expo install react-native-purchases
npx expo run:ios   # (and/or run:android) to rebuild the native dev client
```
Expected: `react-native-purchases` added to `package.json`; dev build compiles with the native module linked. (Not usable in Expo Go — this project uses dev builds.)

- [ ] **Step 2: Write the purchases module**

```ts
// src/lib/purchases.ts
import { Platform } from 'react-native';
import Purchases, { type CustomerInfo } from 'react-native-purchases';

const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY ?? '';
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY ?? '';

let configured = false;

// Call once at app startup. No-op (and stays unconfigured) when no key is
// present — e.g. tests or a build without RevenueCat env — so callers degrade
// to the free baseline instead of throwing.
export function configurePurchases(): void {
  if (configured) return;
  const apiKey = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) return;
  Purchases.configure({ apiKey });
  configured = true;
}

export function isPurchasesConfigured(): boolean {
  return configured;
}

export async function loginPurchases(userId: string): Promise<void> {
  if (!configured) return;
  try { await Purchases.logIn(userId); } catch { /* non-fatal; UI falls back to free */ }
}

export async function logoutPurchases(): Promise<void> {
  if (!configured) return;
  try { await Purchases.logOut(); } catch { /* non-fatal */ }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try { return await Purchases.getCustomerInfo(); } catch { return null; }
}

export function addCustomerInfoListener(cb: (info: CustomerInfo) => void): () => void {
  if (!configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(cb);
  return () => Purchases.removeCustomerInfoUpdateListener(cb);
}
```

- [ ] **Step 3: Type-check**

Run: `npm run typecheck`
Expected: no new errors from `src/lib/purchases.ts`. (A pre-existing TS2322 in `hooks.ts:5037` is known tech debt — ignore it.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/lib/purchases.ts
git commit -m "feat(billing): RevenueCat SDK + purchases module (configure/login/logout)"
```

---

## Task 6: Client entitlement resolver (pure, Jest-tested)

**Files:**
- Create: `src/lib/entitlement.ts`
- Test: `src/lib/entitlement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/entitlement.test.ts
import { resolveEntitlement, FREE } from './entitlement';

test('no customer info -> free', () => {
  expect(resolveEntitlement(null)).toEqual(FREE);
});

test('no active entitlements -> free', () => {
  expect(resolveEntitlement({ entitlements: { active: {} } })).toEqual(FREE);
});

test('pro trial -> pro with trial fields', () => {
  expect(resolveEntitlement({
    entitlements: { active: { pro: { periodType: 'TRIAL', expirationDate: '2026-01-08T00:00:00Z' } } },
  })).toEqual({ tier: 'pro', isTrial: true, trialEndsAt: '2026-01-08T00:00:00Z', periodEnd: '2026-01-08T00:00:00Z' });
});

test('pro normal -> pro, no trial', () => {
  expect(resolveEntitlement({
    entitlements: { active: { pro: { periodType: 'NORMAL', expirationDate: '2026-02-01T00:00:00Z' } } },
  })).toEqual({ tier: 'pro', isTrial: false, trialEndsAt: null, periodEnd: '2026-02-01T00:00:00Z' });
});

test('pro wins over lite when both active', () => {
  expect(resolveEntitlement({
    entitlements: { active: { lite: { periodType: 'NORMAL' }, pro: { periodType: 'NORMAL' } } },
  }).tier).toBe('pro');
});

test('lite only -> lite', () => {
  expect(resolveEntitlement({
    entitlements: { active: { lite: { periodType: 'NORMAL', expirationDate: '2026-02-01T00:00:00Z' } } },
  }).tier).toBe('lite');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/entitlement.test.ts`
Expected: FAIL — cannot find `./entitlement`.

- [ ] **Step 3: Write the resolver**

```ts
// src/lib/entitlement.ts
export type Tier = 'free' | 'lite' | 'pro';

export type Entitlement = {
  tier: Tier;
  isTrial: boolean;
  trialEndsAt: string | null;
  periodEnd: string | null;
};

// Minimal structural shape of RN Purchases CustomerInfo we depend on. Keeping
// our own shape means tests pass plain objects and the resolver isn't coupled
// to the SDK's full type.
export type CustomerInfoLike = {
  entitlements: {
    active: Record<string, { periodType?: string; expirationDate?: string | null }>;
  };
};

export const FREE: Entitlement = { tier: 'free', isTrial: false, trialEndsAt: null, periodEnd: null };

export function resolveEntitlement(info: CustomerInfoLike | null | undefined): Entitlement {
  const active = info?.entitlements?.active ?? {};
  const picked = active['pro']
    ? { tier: 'pro' as Tier, e: active['pro'] }
    : active['lite']
      ? { tier: 'lite' as Tier, e: active['lite'] }
      : null;
  if (!picked) return FREE;
  const isTrial = picked.e.periodType === 'TRIAL';
  const periodEnd = picked.e.expirationDate ?? null;
  return { tier: picked.tier, isTrial, trialEndsAt: isTrial ? periodEnd : null, periodEnd };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/entitlement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entitlement.ts src/lib/entitlement.test.ts
git commit -m "feat(billing): client resolveEntitlement (pro > lite > free)"
```

---

## Task 7: `useEntitlement()` hook + replace the stub + auth wiring

**Files:**
- Modify: `src/lib/types.ts:10-14` (the `Subscription` stub)
- Modify: `src/lib/hooks.ts:207-211` (`useSubscription`) and imports
- Modify: `App.tsx` (configure at startup; login/logout on auth change)

- [ ] **Step 1: Update the types**

In `src/lib/types.ts`, keep `Subscription` (Settings still uses its shape) and re-export the new `Entitlement` for convenience. Replace lines 10-14 with:

```ts
export type Subscription = {
  priceKr: number;
  plan: string;
  renewalDate: string;
};

export type { Entitlement, Tier } from './entitlement';
```

- [ ] **Step 2: Add the hook and re-point `useSubscription`**

In `src/lib/hooks.ts`, add imports near the other `./` imports:

```ts
import {
  resolveEntitlement,
  FREE,
  type Entitlement,
  type CustomerInfoLike,
} from './entitlement';
import { getCustomerInfo, addCustomerInfoListener } from './purchases';
```

Then replace the existing `useSubscription` (lines 207-211) with:

```ts
export function useEntitlement(): Result<Entitlement> {
  const { user, initializing } = useAuth();
  const [info, setInfo] = useState<CustomerInfoLike | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getCustomerInfo().then((ci) => {
      if (!alive) return;
      setInfo(ci as CustomerInfoLike | null);
      setLoading(false);
    });
    const unsub = addCustomerInfoListener((ci) => {
      if (alive) setInfo(ci as CustomerInfoLike);
    });
    return () => { alive = false; unsub(); };
  }, [user?.id]);

  if (isDemoUser(user)) {
    return empty({ tier: 'pro', isTrial: false, trialEndsAt: null, periodEnd: null });
  }
  if (initializing || loading) return { data: FREE, loading: true, error: null };
  return empty(resolveEntitlement(info));
}

// Back-compat for Settings, which renders the legacy Subscription shape.
const TIER_PRICE: Record<'lite' | 'pro', { priceKr: number; plan: string }> = {
  lite: { priceKr: 49, plan: 'Lite' },
  pro: { priceKr: 99, plan: 'Pro' },
};

export function useSubscription(): Result<Subscription | null> {
  const { user } = useAuth();
  const ent = useEntitlement();
  if (isDemoUser(user)) return empty(DEMO_SUBSCRIPTION);
  if (ent.loading) return { data: null, loading: true, error: null };
  const tier = ent.data.tier;
  if (tier === 'free') return empty(null);
  const meta = TIER_PRICE[tier];
  return empty({ priceKr: meta.priceKr, plan: meta.plan, renewalDate: ent.data.periodEnd ?? '' });
}
```

Note: hooks must be called unconditionally, so `useEntitlement()` is invoked before the `isDemoUser` early return inside `useSubscription`. Keep the `Subscription` import already present at `hooks.ts:160`.

- [ ] **Step 3: Wire configure + login/logout in `App.tsx`**

Add the import near the other `src/lib` imports (around line 58):

```ts
import { configurePurchases, loginPurchases, logoutPurchases } from './src/lib/purchases';
```

Add two effects inside the app component (after the existing `useAuth()` destructure at line 118). Configure once on mount; sync identity whenever the user changes:

```ts
useEffect(() => {
  configurePurchases();
}, []);

useEffect(() => {
  if (user?.id) void loginPurchases(user.id);
  else void logoutPurchases();
}, [user?.id]);
```

- [ ] **Step 4: Type-check + run the full client test suite**

Run: `npm run typecheck && npx jest`
Expected: no new type errors (ignore the known pre-existing `hooks.ts:5037` TS2322); all Jest tests pass, including `src/lib/entitlement.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/hooks.ts App.tsx
git commit -m "feat(billing): useEntitlement hook + RevenueCat identity wiring

- useEntitlement reads customerInfo; useSubscription now derives from it
- configurePurchases on mount; logIn/logOut on auth change"
```

---

## Task 8: Minimal dev purchase trigger

A `__DEV__`-guarded button to exercise the full sandbox → webhook → table loop. The real paywall is sub-project #3.

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`

- [ ] **Step 1: Add the dev handler + button**

At the top of `SettingsScreen.tsx`, add:

```ts
import Purchases from 'react-native-purchases';
import { Alert } from 'react-native';
```

Add a handler inside the component:

```ts
const handleDevPurchase = async () => {
  try {
    const offerings = await Purchases.getOfferings();
    const pkg = offerings.current?.availablePackages?.[0];
    if (!pkg) { Alert.alert('No offering', 'No RevenueCat packages available.'); return; }
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    const active = Object.keys(customerInfo.entitlements.active);
    Alert.alert('Purchase OK', `Active entitlements: ${active.join(', ') || 'none'}`);
  } catch (e) {
    Alert.alert('Purchase failed', String((e as Error)?.message ?? e));
  }
};
```

Render a button only in dev, in the existing dev/debug section if one exists, otherwise at the bottom of the settings list:

```tsx
{__DEV__ && (
  <Pressable onPress={handleDevPurchase} style={{ padding: 16 }}>
    <Text>[DEV] Trigger RevenueCat purchase</Text>
  </Pressable>
)}
```

(Match the surrounding `Pressable`/`Text` style components already used in this screen.)

- [ ] **Step 2: Type-check**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/screens/SettingsScreen.tsx
git commit -m "feat(billing): __DEV__ purchase trigger to test the entitlement loop"
```

---

## Task 9: End-to-end sandbox verification

No code — proves the whole loop. Requires the Prerequisites done and the StoreKit sandbox tester (iOS) or a Play license tester (Android) signed in on the device.

- [ ] **Step 1: Buy via the dev trigger**

On a dev build (with `EXPO_PUBLIC_RC_*` keys set), open Settings → tap **[DEV] Trigger RevenueCat purchase** → complete the sandbox purchase (use the Pro package). Expect the success alert listing `pro`.

- [ ] **Step 2: Confirm client state**

Anywhere `useEntitlement()` is read (or add a temporary log), confirm `tier === 'pro'` and `isTrial === true` (sandbox intro offer).

- [ ] **Step 3: Confirm the webhook synced the server**

Via Supabase MCP `execute_sql`:
```sql
select user_id, tier, is_trial, product_id, current_period_end
from user_entitlements
where user_id = '<your sandbox user id>';
```
Expected: one row, `tier='pro'`, `is_trial=true`.

- [ ] **Step 4: Confirm the free default**

Query a user with no row (or your own after deleting the row): `getEntitlement` / `useEntitlement` resolve to `free`.
```sql
delete from user_entitlements where user_id = '<your sandbox user id>';
```
Expected: deletion succeeds; the client falls back to `free` on next `customerInfo` refresh after expiry. (In sandbox, the intro offer renews fast — fine for testing.)

- [ ] **Step 5: Final verification of the suite**

Run:
```bash
deno test supabase/functions/_shared/entitlement.test.ts supabase/functions/revenuecat-webhook/handler.test.ts
npx jest src/lib/entitlement.test.ts
npm run typecheck
```
Expected: all green; typecheck clean except the known pre-existing `hooks.ts:5037`.

---

## Done criteria

- `user_entitlements` table live with RLS; webhook deployed (`--no-verify-jwt`) and smoke-passed.
- A sandbox purchase flows end-to-end: store → RevenueCat → webhook → table, and the client `useEntitlement()` reflects it.
- A user with no row resolves to `free` on both client and server.
- All new unit tests pass; typecheck clean (modulo the known pre-existing error).
- **Not** included (later sub-projects): feature gating / free-tier caps (#2), paywall UI (#3), forced-win onboarding + trial nudge + manual triggers (#4).
