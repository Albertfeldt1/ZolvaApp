import { buildImageOnlySignature, useScreenshotResultMessage } from '../use-screenshot';
import type { InlineImage } from '../types';

describe('buildImageOnlySignature', () => {
  const img: InlineImage = {
    base64: 'AAAA',
    mimeType: 'image/jpeg',
    width: 600,
    height: 200,
  };

  it('returns kind=imported with the inline image', () => {
    const sig = buildImageOnlySignature(img, 1700000000000);
    expect(sig.kind).toBe('imported');
    expect(sig.image).toBe(img);
    expect(sig.importedAt).toBe(1700000000000);
    expect(sig.socials).toEqual([]);
    expect(sig.plaintext).toBe('');
  });

  it('produces html that is a single cid:zolva-sig image wrapped in a table', () => {
    const sig = buildImageOnlySignature(img, 0);
    expect(sig.html).toContain('<table');
    expect(sig.html).toContain('src="cid:zolva-sig"');
    expect(sig.html).toContain('max-width:600px');
    // No other content beyond the image cell.
    expect(sig.html).not.toMatch(/<p\b/);
  });
});

describe('useScreenshotResultMessage', () => {
  it('returns Danish messages for each failure reason', () => {
    expect(useScreenshotResultMessage({ ok: false, reason: 'permission-denied' })).toContain('Indstillinger');
    expect(useScreenshotResultMessage({ ok: false, reason: 'cancelled' })).toBe('');
    expect(useScreenshotResultMessage({ ok: false, reason: 'too-large' })).toContain('for stort');
    expect(useScreenshotResultMessage({ ok: false, reason: 'parse-failed' })).toContain('billedet');
  });
});
