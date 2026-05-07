// src/lib/mail-signature/__tests__/build-outgoing-body.test.ts
import { buildOutgoingBody } from '../build-outgoing-body';
import { saveSignature, __resetForTests, __setCurrentUserForTests } from '../storage';
import { EMPTY_SIGNATURE, type SignatureData } from '../types';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    _store: new Map<string, string>(),
    async getItem(k: string) { return (this as any)._store.get(k) ?? null; },
    async setItem(k: string, v: string) { (this as any)._store.set(k, v); },
    async removeItem(k: string) { (this as any)._store.delete(k); },
    async clear() { (this as any)._store.clear(); },
  },
}));

// stub subscribeUserId so the storage module's at-import-time binding is a no-op;
// tests set the current user explicitly via __setCurrentUserForTests.
jest.mock('../../auth', () => ({
  subscribeUserId: (_cb: (uid: string | null) => void) => () => {},
}));

describe('buildOutgoingBody', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
    __setCurrentUserForTests('user-1');
  });

  it('returns text body unchanged when no signature is configured', async () => {
    const out = await buildOutgoingBody('Hej Anne');
    expect(out).toEqual({ contentType: 'text', content: 'Hej Anne', attachments: [] });
  });

  it('returns html body with signature when text-only signature is configured', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'Albert', title: 'CEO' });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('<p>Hej Anne</p>');
    expect(out.content).toContain('<strong>Albert</strong>');
    expect(out.attachments).toEqual([]);
  });

  it('returns html body + inline attachment when logo is configured', async () => {
    await saveSignature('user-1', {
      ...EMPTY_SIGNATURE,
      name: 'Albert',
      logo: { base64: 'AAAA', mimeType: 'image/png', width: 100, height: 30 },
    });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('cid:zolva-sig');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]).toEqual({
      filename: 'signature.png',
      mimeType: 'image/png',
      contentBytes: 'AAAA',
      contentId: 'zolva-sig',
    });
  });

  it('uses .jpg filename for jpeg logos', async () => {
    await saveSignature('user-1', {
      ...EMPTY_SIGNATURE,
      name: 'Albert',
      logo: { base64: 'BBBB', mimeType: 'image/jpeg', width: 100, height: 30 },
    });
    const out = await buildOutgoingBody('Hej Anne');
    expect(out.attachments[0].filename).toBe('signature.jpg');
  });

  it('escapes HTML in the user body', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'A' });
    const out = await buildOutgoingBody('<script>x</script>');
    expect(out.content).toContain('&lt;script&gt;');
    expect(out.content).not.toContain('<script>');
  });

  it('preserves paragraph breaks in the user body', async () => {
    await saveSignature('user-1', { ...EMPTY_SIGNATURE, name: 'A' });
    const out = await buildOutgoingBody('para1\n\npara2');
    expect(out.content).toContain('<p>para1</p><p>para2</p>');
  });
});

describe('buildOutgoingBody - imported signatures', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
    __setCurrentUserForTests('user-1');
  });

  it('returns html with the imported signature appended and logo as attachment', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: { base64: 'AAAA', mimeType: 'image/png' as const, width: 100, height: 50 },
      importedAt: 1700000000000,
      socials: [],
    };
    await saveSignature('user-1', imported);
    const out = await buildOutgoingBody('Hello world');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('<table>');
    expect(out.content).toContain('Hi');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].contentId).toBe('zolva-sig');
    expect(out.attachments[0].mimeType).toBe('image/png');
  });

  it('returns html with no attachments when imported signature has no logo', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: null,
      importedAt: 1700000000000,
      socials: [],
    };
    await saveSignature('user-1', imported);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.attachments).toHaveLength(0);
  });

  it('returns text when imported signature has empty html and no image', async () => {
    const imported = {
      kind: 'imported' as const,
      html: '',
      plaintext: '',
      image: null,
      importedAt: 1700000000000,
      socials: [],
    };
    await saveSignature('user-1', imported);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('text');
    expect(out.attachments).toHaveLength(0);
  });
});

describe('buildOutgoingBody - socials integration', () => {
  beforeEach(async () => {
    await (AsyncStorage as any).clear();
    __resetForTests();
    __setCurrentUserForTests('user-1');
  });

  it('appends socials row to structured-mode html', async () => {
    const sig: SignatureData = {
      kind: 'structured',
      name: 'Albert', title: '', company: '', phone: '', email: '',
      website: '', customLines: '', logo: null,
      socials: [{ type: 'linkedin', url: 'https://linkedin.com/in/albert' }],
    };
    await saveSignature('user-1', sig);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('LinkedIn');
    expect(out.content).toContain('href="https://linkedin.com/in/albert"');
  });

  it('appends socials row to imported-mode html', async () => {
    const sig: SignatureData = {
      kind: 'imported',
      html: '<table><tr><td>Hi</td></tr></table>',
      plaintext: 'Hi',
      image: null,
      importedAt: 1700000000000,
      socials: [{ type: 'github', url: 'https://github.com/albert' }],
    };
    await saveSignature('user-1', sig);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    expect(out.content).toContain('Hi');
    expect(out.content).toContain('GitHub');
  });

  it('imported with ONE bound social (target word) → word wrapped inline, no separate pill', async () => {
    const sig: SignatureData = {
      kind: 'imported',
      html: '<table><tr><td>Se mere her for info</td></tr></table>',
      plaintext: 'Se mere her for info',
      image: null,
      importedAt: 1700000000000,
      socials: [
        {
          type: 'website',
          url: 'https://example.com',
          target: { kind: 'word', text: 'her' },
        },
      ],
    };
    await saveSignature('user-1', sig);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    // The word "her" must be wrapped with the URL
    expect(out.content).toContain('<a href="https://example.com"');
    expect(out.content).toContain('>her</a>');
    // No separate socials pill row (no unbound socials)
    // The socials row div has a specific style - should not be present
    expect(out.content).not.toContain('text-decoration:none">');
  });

  it('imported with mixed bound + unbound → binding applied AND separate row for unbound', async () => {
    const sig: SignatureData = {
      kind: 'imported',
      html: '<p>Connect her or via socials</p>',
      plaintext: 'Connect her or via socials',
      image: null,
      importedAt: 1700000000000,
      socials: [
        {
          type: 'linkedin',
          url: 'https://linkedin.com/in/albert',
          target: { kind: 'word', text: 'her' },
        },
        {
          type: 'github',
          url: 'https://github.com/albert',
          // no target - unbound
        },
      ],
    };
    await saveSignature('user-1', sig);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    // Bound word wrapped
    expect(out.content).toContain('<a href="https://linkedin.com/in/albert"');
    expect(out.content).toContain('>her</a>');
    // Unbound social rendered as separate pill
    expect(out.content).toContain('GitHub');
    expect(out.content).toContain('href="https://github.com/albert"');
  });

  it('structured with bound social (target set) → binding ignored, social renders as separate pill', async () => {
    const sig: SignatureData = {
      kind: 'structured',
      name: 'Albert',
      title: '',
      company: '',
      phone: '',
      email: '',
      website: '',
      customLines: '',
      logo: null,
      socials: [
        {
          type: 'linkedin',
          url: 'https://linkedin.com/in/albert',
          // target set, but structured mode ignores it
          target: { kind: 'word', text: 'Albert' },
        },
      ],
    };
    await saveSignature('user-1', sig);
    const out = await buildOutgoingBody('Hello');
    expect(out.contentType).toBe('html');
    // The social must still appear as a separate pill (not bound into the signature)
    expect(out.content).toContain('LinkedIn');
    expect(out.content).toContain('href="https://linkedin.com/in/albert"');
    // The text "Albert" in the signature should NOT be wrapped as a link
    // (it appears in the structured sig as <strong>Albert</strong>)
    expect(out.content).toContain('<strong>Albert</strong>');
    expect(out.content).not.toMatch(/<a[^>]*>Albert<\/a>/);
  });
});
