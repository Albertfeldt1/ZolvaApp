// src/lib/__tests__/mail-network-match.test.ts
// Afsender→person-matchningen bag auto-loggede mail-interaktioner.
// Funktionerne er rene; supabase/hooks mockes væk som i network-store.test.ts.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn(() => true) }));
jest.mock('../profile', () => ({
  PROFILE_MEMORY_ENABLED: true,
  invalidatePreamble: jest.fn(),
}));

import { displayNameFromAddr, matchPersonForMail } from '../mail-events';
import { normalizePersonName, type NetworkPerson } from '../network-store';

const person = (over: Partial<NetworkPerson> & { name: string }): NetworkPerson => ({
  id: over.name,
  userId: 'u1',
  normalizedName: normalizePersonName(over.name),
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

describe('displayNameFromAddr', () => {
  it('trækker navnet ud af "Name <email>"', () => {
    expect(displayNameFromAddr('Mette Halling <mette@lunar.app>')).toBe('Mette Halling');
    expect(displayNameFromAddr('"Halling, Mette" <mette@lunar.app>')).toBe('Halling, Mette');
  });

  it('returnerer null for bare adresser og tomme headers', () => {
    expect(displayNameFromAddr('mette@lunar.app')).toBeNull();
    expect(displayNameFromAddr('<mette@lunar.app>')).toBeNull();
    expect(displayNameFromAddr(null)).toBeNull();
  });
});

describe('matchPersonForMail', () => {
  const mette = person({ id: 'm', name: 'Mette Halling', email: 'mette@lunar.app' });
  const navnebror = person({ id: 'n', name: 'Mette Halling', email: 'mette@andet.dk' });
  const lars = person({ id: 'l', name: 'Lars Jensen' });

  it('email-match vinder over navne-match', () => {
    const hit = matchPersonForMail([navnebror, mette], 'Mette Halling <METTE@LUNAR.APP>');
    expect(hit?.id).toBe('m');
  });

  it('falder tilbage til visningsnavn når emailen er ukendt', () => {
    const hit = matchPersonForMail([mette, lars], 'Lars Jensen <lj@nytfirma.dk>');
    expect(hit?.id).toBe('l');
  });

  it('returnerer null uden email- eller navnematch', () => {
    expect(matchPersonForMail([mette], 'Ukendt Afsender <x@y.dk>')).toBeNull();
    expect(matchPersonForMail([mette], 'noreply@nyhedsbrev.dk')).toBeNull();
    expect(matchPersonForMail([], 'Mette Halling <mette@lunar.app>')).toBeNull();
  });
});
