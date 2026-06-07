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
