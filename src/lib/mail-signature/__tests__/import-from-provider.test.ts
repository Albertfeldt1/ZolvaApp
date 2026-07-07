// src/lib/mail-signature/__tests__/import-from-provider.test.ts
//
// Pure parts of the provider signature import: Outlook block extraction,
// image src rewriting, plaintext derivation, and the shared finalize step.
// The orchestrators depend on live provider calls and are verified manually.

// import-from-provider → import-from-screenshot → claude → supabase →
// AsyncStorage; mocking claude cuts the native-module chain (same trick
// as import-from-screenshot.test.ts).
jest.mock('../../claude', () => ({
  ClaudeRateLimitError: class extends Error {},
  ClaudeConfigError: class extends Error {},
  completeWithTool: jest.fn(),
}));

jest.mock('../../auth', () => {
  class ProviderAuthErrorMock extends Error {
    constructor(provider: string, message: string) {
      super(message);
      this.name = 'ProviderAuthError';
    }
  }
  return { ProviderAuthError: ProviderAuthErrorMock };
});

jest.mock('../../gmail', () => ({ fetchGmailSignatureHtml: jest.fn() }));

jest.mock('../../microsoft-graph', () => ({
  listSentMessageBodies: jest.fn(),
  getInlineImageAttachment: jest.fn(),
}));

jest.mock('../../network-errors', () => {
  class NetworkTimeoutErrorMock extends Error {
    constructor() {
      super('timeout');
      this.name = 'NetworkTimeoutError';
    }
  }
  return { NetworkTimeoutError: NetworkTimeoutErrorMock };
});

import {
  extractOutlookSignatureHtml,
  finalizeImportedSignature,
  htmlToPlaintext,
  rewriteFirstImageToCid,
} from '../import-from-provider';

describe('extractOutlookSignatureHtml', () => {
  it('lifts the balanced Signature div out of a sent-mail body', () => {
    const body = '<html><body><div>Hej Jens</div><div id="Signature"><div><b>Oscar</b></div><div>Zolva</div></div><div>quoted reply</div></body></html>';
    expect(extractOutlookSignatureHtml(body)).toBe(
      '<div id="Signature"><div><b>Oscar</b></div><div>Zolva</div></div>',
    );
  });

  it('handles nested divs and extra attributes', () => {
    const body = '<div class="x" id="Signature" dir="ltr"><div><div>a</div></div></div><div>rest</div>';
    expect(extractOutlookSignatureHtml(body)).toBe(
      '<div class="x" id="Signature" dir="ltr"><div><div>a</div></div></div>',
    );
  });

  it('matches the id case-insensitively', () => {
    expect(extractOutlookSignatureHtml("<div id='signature'>Sig</div>")).toBe(
      "<div id='signature'>Sig</div>",
    );
  });

  it('returns null when there is no marker (e.g. mail sent through Zolva)', () => {
    expect(extractOutlookSignatureHtml('<div>Venlig hilsen<br>Oscar</div>')).toBeNull();
  });

  it('returns null on unbalanced markup instead of guessing', () => {
    expect(extractOutlookSignatureHtml('<div id="Signature"><div>a</div>')).toBeNull();
  });
});

describe('rewriteFirstImageToCid', () => {
  it('rewrites the first http(s) image and reports src + declared size', () => {
    const html = '<div><img src="https://cdn.zolva.io/logo.png" width="120" height="40" alt=""><span>Zolva</span></div>';
    const r = rewriteFirstImageToCid(html);
    expect(r.src).toBe('https://cdn.zolva.io/logo.png');
    expect(r.width).toBe(120);
    expect(r.height).toBe(40);
    expect(r.html).toContain('src="cid:zolva-sig"');
    expect(r.html).not.toContain('cdn.zolva.io');
  });

  it('rewrites cid images (Outlook inline logos)', () => {
    const r = rewriteFirstImageToCid('<img src="cid:image001.png@01DA">');
    expect(r.src).toBe('cid:image001.png@01DA');
    expect(r.html).toBe('<img src="cid:zolva-sig">');
  });

  it('skips data: URIs and images without src', () => {
    const r = rewriteFirstImageToCid('<img src="data:image/png;base64,AAAA"><img alt="x">');
    expect(r.src).toBeNull();
    expect(r.html).toContain('data:image/png');
  });

  it('only rewrites the first importable image', () => {
    const r = rewriteFirstImageToCid('<img src="https://a/1.png"><img src="https://a/2.png">');
    expect(r.html).toBe('<img src="cid:zolva-sig"><img src="https://a/2.png">');
  });
});

describe('htmlToPlaintext', () => {
  it('converts breaks and block ends to newlines and decodes entities', () => {
    const text = htmlToPlaintext('<div>Oscar &amp; co</div><div>CEO<br>Zolva&nbsp;ApS</div>');
    expect(text).toBe('Oscar & co\nCEO\nZolva ApS');
  });

  it('breaks on OPENING block tags too - Gmail signature shape', () => {
    // Real Gmail sendAs signatures put the salutation as bare text before
    // the first <div>; breaking only on closes glued "Venlig hilsen." onto
    // the name.
    const text = htmlToPlaintext(
      'Venlig hilsen.<div>Oscar Hangaard</div><div>+45 29 84 77 16</div><div>oscar@zolva.io</div>',
    );
    expect(text).toBe('Venlig hilsen.\nOscar Hangaard\n+45 29 84 77 16\noscar@zolva.io');
  });

  it('collapses adjacent close+open pairs to a single line break', () => {
    expect(htmlToPlaintext('<p>a</p><p>b</p>')).toBe('a\nb');
  });
});

describe('finalizeImportedSignature', () => {
  it('sanitizes dangerous markup and derives plaintext', () => {
    const data = finalizeImportedSignature(
      '<div id="Signature"><script>alert(1)</script><b>Oscar</b><br>Zolva</div>',
      null,
      123,
    );
    expect(data).not.toBeNull();
    expect(data!.html).not.toContain('script');
    expect(data!.plaintext).toBe('Oscar\nZolva');
    expect(data!.importedAt).toBe(123);
    expect(data!.kind).toBe('imported');
  });

  it('strips the cid image reference when no image bytes were resolved', () => {
    const data = finalizeImportedSignature('<div><img src="cid:zolva-sig"><b>Oscar</b></div>', null);
    expect(data!.html).not.toContain('cid:zolva-sig');
  });

  it('keeps the cid image when bytes were resolved', () => {
    const image = { base64: 'AAAA', mimeType: 'image/png' as const, width: 10, height: 10 };
    const data = finalizeImportedSignature('<div><img src="cid:zolva-sig"><b>Oscar</b></div>', image);
    expect(data!.html).toContain('cid:zolva-sig');
    expect(data!.image).toEqual(image);
  });

  it('returns null when nothing usable survives', () => {
    expect(finalizeImportedSignature('<script>x</script>', null)).toBeNull();
    expect(finalizeImportedSignature('', null)).toBeNull();
  });
});
