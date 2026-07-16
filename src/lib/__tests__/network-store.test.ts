// src/lib/__tests__/network-store.test.ts
// Merge-politikken og roster-matchet er de to funktioner der afgør om
// AI-ekstraktion nogensinde må overskrive brugerdata eller oprette dubletter
// — de er rene, så de testes uden Supabase.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

import {
  findRosterMatch,
  mergeAiIntoPerson,
  normalizePersonName,
  type NetworkPerson,
} from '../network-store';

const person = (over: Partial<NetworkPerson>): NetworkPerson => ({
  id: 'p1',
  userId: 'u1',
  name: 'Lars Poulsen',
  normalizedName: normalizePersonName(over.name ?? 'Lars Poulsen'),
  company: null,
  role: null,
  relation: null,
  industry: null,
  howWeMet: null,
  location: null,
  email: null,
  phone: null,
  linkedin: null,
  traits: [],
  interests: [],
  projects: [],
  notes: null,
  summary: null,
  status: 'confirmed',
  metThroughPersonId: null,
  userEditedFields: [],
  source: null,
  lastContactedAt: null,
  createdAt: new Date('2026-07-01T10:00:00Z'),
  updatedAt: new Date('2026-07-01T10:00:00Z'),
  ...over,
});

describe('mergeAiIntoPerson', () => {
  it('udfylder tomme skalarer men overskriver aldrig udfyldte', () => {
    const p = person({ role: 'Erhvervssalg' });
    const patch = mergeAiIntoPerson(p, { role: 'Direktør', location: 'Aarhus' });
    expect(patch).toEqual({ location: 'Aarhus' });
  });

  it('respekterer bruger-redigerede felter selv når de er tomme', () => {
    const p = person({ location: null, userEditedFields: ['location'] });
    expect(mergeAiIntoPerson(p, { location: 'Aarhus' })).toBeNull();
  });

  it('appender arrays med case-insensitiv dedup', () => {
    const p = person({ traits: ['mørkt hår'] });
    const patch = mergeAiIntoPerson(p, { traits: ['Mørkt hår', 'høj', 'høj'] });
    expect(patch).toEqual({ traits: ['mørkt hår', 'høj'] });
  });

  it('lader AI opdatere summary men returnerer null når intet ændres', () => {
    const p = person({ summary: 'Sælger hos Volvo' });
    expect(mergeAiIntoPerson(p, { summary: 'Sælger hos Volvo' })).toBeNull();
    expect(mergeAiIntoPerson(p, { summary: 'Erhvervssalg hos Volvo' })).toEqual({
      summary: 'Erhvervssalg hos Volvo',
    });
  });

  it('ignorerer tomme/whitespace-værdier fra modellen', () => {
    const p = person({});
    expect(mergeAiIntoPerson(p, { company: '  ', traits: [' '] })).toBeNull();
  });
});

describe('findRosterMatch', () => {
  const roster = [
    person({ id: 'a', name: 'Lars Poulsen', company: 'Volvo' }),
    person({ id: 'b', name: 'Lars Poulsen', company: 'Danske Bank' }),
    person({ id: 'c', name: 'Mette Halling', company: null }),
  ];

  it('matcher på normaliseret navn + firma når begge kendes', () => {
    expect(findRosterMatch(roster, 'lars poulsen', 'volvo')?.id).toBe('a');
    expect(findRosterMatch(roster, 'Lars Poulsen', 'Danske Bank')?.id).toBe('b');
  });

  it('matcher på navn alene når firma er ukendt på en af siderne', () => {
    expect(findRosterMatch(roster, 'Mette Halling', 'Lunar')?.id).toBe('c');
    expect(findRosterMatch(roster, 'Lars Poulsen', null)?.id).toBe('a');
  });

  it('returnerer null for ukendte navne og tomme strenge', () => {
    expect(findRosterMatch(roster, 'Karin Berg', null)).toBeNull();
    expect(findRosterMatch(roster, '   ', null)).toBeNull();
  });
});
