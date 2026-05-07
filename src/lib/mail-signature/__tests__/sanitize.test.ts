// src/lib/mail-signature/__tests__/sanitize.test.ts
import { sanitizeSignatureHtml } from '../sanitize';

describe('sanitizeSignatureHtml - basic input handling', () => {
  it('returns empty string for null/undefined/non-string input', () => {
    expect(sanitizeSignatureHtml(null as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml(undefined as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml(42 as unknown as string)).toBe('');
    expect(sanitizeSignatureHtml({} as unknown as string)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeSignatureHtml('')).toBe('');
  });

  it('preserves plain text without tags', () => {
    expect(sanitizeSignatureHtml('Albert Hangaard')).toBe('Albert Hangaard');
  });

  it('preserves HTML entities', () => {
    expect(sanitizeSignatureHtml('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
  });
});

describe('sanitizeSignatureHtml - tag allowlist', () => {
  it('keeps allowed structural tags', () => {
    const input = '<table><tr><td><div><span>Hi</span></div></td></tr></table>';
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain('<table>');
    expect(out).toContain('<span>');
  });

  it('keeps anchor and image and inline-format tags', () => {
    const input = '<a href="mailto:a@b.dk">x</a><img src="cid:zolva-sig"><b>x</b><strong>x</strong><i>x</i><em>x</em><br><hr>';
    const out = sanitizeSignatureHtml(input);
    expect(out).toContain('<a ');
    expect(out).toContain('<img');
    expect(out).toContain('<b>');
    expect(out).toContain('<br>');
    expect(out).toContain('<hr>');
  });

  it('strips disallowed tags including their inner content', () => {
    expect(sanitizeSignatureHtml('<script>alert(1)</script>x')).not.toContain('<script>');
    expect(sanitizeSignatureHtml('<script>alert(1)</script>x')).toContain('x');
    expect(sanitizeSignatureHtml('<style>body{}</style>x')).not.toContain('<style>');
    expect(sanitizeSignatureHtml('<iframe src="x">x</iframe>')).not.toContain('<iframe');
    expect(sanitizeSignatureHtml('<object data="x"></object>')).not.toContain('<object');
    expect(sanitizeSignatureHtml('<svg><script>x</script></svg>')).not.toContain('<svg');
  });

  it('strips inner content of stripped tags', () => {
    const out = sanitizeSignatureHtml('<style>body{color:red}</style>visible');
    expect(out).not.toMatch(/body\{/);
    expect(out).toContain('visible');
  });

  it('handles nested strip-with-content tags without leaking middle content', () => {
    const out = sanitizeSignatureHtml('<script>outer<script>inner</script>middle</script>after');
    expect(out).not.toContain('outer');
    expect(out).not.toContain('inner');
    expect(out).not.toContain('middle');
    expect(out).toContain('after');
  });

  it('handles nested strip-with-content tags of different types', () => {
    const out = sanitizeSignatureHtml('<style><svg>nested</svg>still in style</style>visible');
    expect(out).not.toContain('nested');
    expect(out).not.toContain('still in style');
    expect(out).toContain('visible');
  });

  it('strips HTML comments', () => {
    expect(sanitizeSignatureHtml('<!--evil-->ok')).toBe('ok');
  });

  it('strips DOCTYPE', () => {
    expect(sanitizeSignatureHtml('<!DOCTYPE html>x')).toBe('x');
  });
});

describe('sanitizeSignatureHtml - href and src URL schemes', () => {
  it('keeps mailto href', () => {
    expect(sanitizeSignatureHtml('<a href="mailto:a@b.dk">x</a>')).toContain('href="mailto:a@b.dk"');
  });

  it('keeps tel href', () => {
    expect(sanitizeSignatureHtml('<a href="tel:+4512345678">x</a>')).toContain('href="tel:+4512345678"');
  });

  it('keeps http and https href', () => {
    expect(sanitizeSignatureHtml('<a href="https://zolva.io">x</a>')).toContain('href="https://zolva.io"');
    expect(sanitizeSignatureHtml('<a href="http://zolva.io">x</a>')).toContain('href="http://zolva.io"');
  });

  it('strips javascript scheme href', () => {
    const out = sanitizeSignatureHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript');
  });

  it('strips unknown scheme href', () => {
    const out = sanitizeSignatureHtml('<a href="data:text/html,abc">x</a>');
    expect(out).not.toContain('data:');
  });

  it('keeps cid:zolva-sig img src', () => {
    expect(sanitizeSignatureHtml('<img src="cid:zolva-sig">')).toContain('src="cid:zolva-sig"');
  });

  it('strips img with non-allowed src', () => {
    expect(sanitizeSignatureHtml('<img src="https://evil/x.png">')).not.toContain('src=');
    expect(sanitizeSignatureHtml('<img src="data:image/png;base64,AAA">')).not.toContain('src=');
    expect(sanitizeSignatureHtml('<img src="cid:other">')).not.toContain('src=');
  });
});

describe('sanitizeSignatureHtml - style attribute filtering', () => {
  it('keeps allowed CSS properties', () => {
    const out = sanitizeSignatureHtml('<div style="color:#1a1a1a;font-size:13px;text-align:left">x</div>');
    expect(out).toContain('color:#1a1a1a');
    expect(out).toContain('font-size:13px');
    expect(out).toContain('text-align:left');
  });

  it('strips disallowed CSS properties', () => {
    const out = sanitizeSignatureHtml('<div style="color:red;position:absolute;transform:rotate(5deg)">x</div>');
    expect(out).toContain('color:red');
    expect(out).not.toMatch(/position\s*:/);
    expect(out).not.toMatch(/transform\s*:/);
  });

  it('strips display:flex but keeps display:block and display:inline-block', () => {
    expect(sanitizeSignatureHtml('<div style="display:flex">x</div>')).not.toMatch(/display\s*:\s*flex/);
    expect(sanitizeSignatureHtml('<div style="display:block">x</div>')).toMatch(/display\s*:\s*block/);
    expect(sanitizeSignatureHtml('<div style="display:inline-block">x</div>')).toMatch(/display\s*:\s*inline-block/);
  });

  it('strips values containing url() with http schemes', () => {
    const out = sanitizeSignatureHtml('<div style="background-image:url(https://evil/x.png)">x</div>');
    expect(out).not.toMatch(/url\(/);
  });

  it('strips values containing dangerous tokens', () => {
    expect(sanitizeSignatureHtml('<div style="color:expression(alert(1))">x</div>')).not.toMatch(/expression/);
    expect(sanitizeSignatureHtml('<div style="background:javascript:foo">x</div>')).not.toContain('javascript');
    expect(sanitizeSignatureHtml('<div style="@import url(x)">x</div>')).not.toContain('@import');
  });

  it('collapses an empty style attribute', () => {
    const out = sanitizeSignatureHtml('<div style="position:absolute">x</div>');
    expect(out).not.toContain('style=""');
    expect(out).not.toContain('style=" "');
  });

  it('handles styles without trailing semicolon', () => {
    expect(sanitizeSignatureHtml('<div style="color:red">x</div>')).toContain('color:red');
  });
});

describe('sanitizeSignatureHtml - attribute allowlist per tag', () => {
  it('keeps table cellpadding/cellspacing/border', () => {
    const out = sanitizeSignatureHtml('<table cellpadding="0" cellspacing="0" border="0"><tr><td>x</td></tr></table>');
    expect(out).toContain('cellpadding="0"');
    expect(out).toContain('cellspacing="0"');
    expect(out).toContain('border="0"');
  });

  it('drops on* event handlers', () => {
    const out = sanitizeSignatureHtml('<div onclick="alert(1)" onmouseover="alert(2)">x</div>');
    expect(out).not.toMatch(/on(click|mouseover)/);
  });

  it('drops random unknown attributes', () => {
    const out = sanitizeSignatureHtml('<div data-evil="x" srcset="x">x</div>');
    expect(out).not.toContain('data-evil');
    expect(out).not.toContain('srcset');
  });
});
