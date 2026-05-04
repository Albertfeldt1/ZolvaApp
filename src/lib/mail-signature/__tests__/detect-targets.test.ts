// src/lib/mail-signature/__tests__/detect-targets.test.ts
import { detectImportedTargets } from '../detect-targets';

describe('detectImportedTargets — invalid / empty input', () => {
  const empty = { words: [], glyphs: [], buttons: [], images: [] };
  it('returns empty arrays for empty string', () => {
    expect(detectImportedTargets('')).toEqual(empty);
  });

  it('returns empty arrays for null input', () => {
    expect(detectImportedTargets(null as unknown as string)).toEqual(empty);
  });

  it('returns empty arrays for numeric input', () => {
    expect(detectImportedTargets(42 as unknown as string)).toEqual(empty);
  });

  it('returns empty arrays for object input', () => {
    expect(detectImportedTargets({} as unknown as string)).toEqual(empty);
  });
});

describe('detectImportedTargets — glyph categorization', () => {
  it('puts single-character tokens (icon stand-ins) into glyphs, not words', () => {
    const result = detectImportedTargets('<span>f</span><span>X</span><span>▶</span>');
    expect(result.glyphs).toEqual(expect.arrayContaining(['f', 'X', '▶']));
    expect(result.words).not.toContain('f');
    expect(result.words).not.toContain('X');
    expect(result.words).not.toContain('▶');
  });

  it('puts symbol-only tokens (no letters/digits) into glyphs', () => {
    const result = detectImportedTargets('<span>@</span><span>++</span>');
    expect(result.glyphs).toContain('@');
    // "++" is symbol-only → glyphs
    expect(result.glyphs).toContain('++');
  });

  it('keeps multi-letter alphanumeric tokens in words', () => {
    const result = detectImportedTargets('<p>Albert Hangaard</p>');
    expect(result.words).toContain('Albert');
    expect(result.words).toContain('Hangaard');
    expect(result.glyphs).not.toContain('Albert');
  });
});

describe('detectImportedTargets — word extraction', () => {
  it('extracts words from plain text', () => {
    const result = detectImportedTargets('Hello world foo');
    expect(result.words).toContain('Hello');
    expect(result.words).toContain('world');
    expect(result.words).toContain('foo');
    expect(result.images).toEqual([]);
  });

  it('keeps short tokens (single chars and ≤2 chars) so icon-stand-ins like "f"/"X"/"in" are bindable', () => {
    const result = detectImportedTargets('Hi me you long');
    expect(result.words).toContain('Hi');
    expect(result.words).toContain('me');
    expect(result.words).toContain('you');
    expect(result.words).toContain('long');
  });

  it('exposes the whole text-node phrase alongside its tokens', () => {
    const result = detectImportedTargets('<a>Find me on Facebook</a><span>Hi</span>');
    // Whole phrase appears as one bindable target …
    expect(result.words).toContain('Find me on Facebook');
    // … and individual tokens are still extractable.
    expect(result.words).toContain('Find');
    expect(result.words).toContain('Facebook');
  });

  it('phrases ending in punctuation survive as a single entry', () => {
    const result = detectImportedTargets("<button>Let's connect!</button>");
    expect(result.words).toContain("Let's connect!");
  });

  it('sorts longer entries before shorter ones (most specific bindings first)', () => {
    const result = detectImportedTargets('<p>Find me on Facebook</p>');
    const phraseIdx = result.words.indexOf('Find me on Facebook');
    const tokenIdx = result.words.indexOf('Find');
    expect(phraseIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(phraseIdx);
  });

  it('filters out pure-numeric tokens', () => {
    const result = detectImportedTargets('Call 12345 now or 999');
    expect(result.words).not.toContain('12345');
    expect(result.words).not.toContain('999');
    expect(result.words).toContain('Call');
    expect(result.words).toContain('now');
  });

  it('splits on punctuation into tokens (and also exposes the whole run as a phrase)', () => {
    const result = detectImportedTargets('her. og, men; dig:');
    // Individual tokens after punctuation split — even ≤2 char ones
    expect(result.words).toContain('her');
    expect(result.words).toContain('og');
    expect(result.words).toContain('men');
    expect(result.words).toContain('dig');
    // Whole text run survives as a phrase candidate too
    expect(result.words).toContain('her. og, men; dig:');
  });

  it('deduplicates words case-insensitively, preserving first-occurrence casing', () => {
    const result = detectImportedTargets('Privacy privacy PRIVACY hello Hello');
    const privacyCount = result.words.filter(w => w.toLowerCase() === 'privacy').length;
    expect(privacyCount).toBe(1);
    // First occurrence wins
    expect(result.words).toContain('Privacy');
    expect(result.words).not.toContain('privacy');
    expect(result.words).not.toContain('PRIVACY');

    const helloCount = result.words.filter(w => w.toLowerCase() === 'hello').length;
    expect(helloCount).toBe(1);
    expect(result.words).toContain('hello');
  });

  it('extracts text from inside HTML tags', () => {
    const result = detectImportedTargets('<div><span>Albert</span> <b>Hangaard</b></div>');
    expect(result.words).toContain('Albert');
    expect(result.words).toContain('Hangaard');
  });

  it('does NOT capture text from HTML attributes as words', () => {
    // href value should not become a word
    const result = detectImportedTargets('<a href="zolva.io">link</a>');
    expect(result.words).toContain('link');
    expect(result.words).not.toContain('zolva.io');
    expect(result.words).not.toContain('zolva');
    expect(result.words).not.toContain('href');
  });

  it('does NOT capture alt attribute text as a word', () => {
    const result = detectImportedTargets('<img src="x.png" alt="Company Logo">');
    // alt text should appear as image description, NOT as words
    expect(result.words).not.toContain('Company');
    expect(result.words).not.toContain('Logo');
  });

  it('caps the candidates list at 50 entries', () => {
    // Generate HTML with 80 distinct words (each in its own block so the
    // phrase entry equals the token).
    const manyTokens = Array.from({ length: 80 }, (_, i) => `<p>word${String(i).padStart(2, '0')}</p>`).join('');
    const result = detectImportedTargets(manyTokens);
    expect(result.words.length).toBeLessThanOrEqual(50);
  });

  it('skips text inside <style> tags defensively', () => {
    const result = detectImportedTargets('<style>body { color: red; }</style>visible');
    expect(result.words).not.toContain('body');
    expect(result.words).not.toContain('color');
    expect(result.words).toContain('visible');
  });

  it('extracts text from nested elements only once', () => {
    const result = detectImportedTargets('<div><span>hello</span></div>');
    const count = result.words.filter(w => w === 'hello').length;
    expect(count).toBe(1);
  });
});

describe('detectImportedTargets — image extraction', () => {
  it('extracts image with alt as description', () => {
    const result = detectImportedTargets('<img src="https://example.com/logo.png" alt="Company Logo">');
    expect(result.images).toEqual([
      { src: 'https://example.com/logo.png', description: 'Company Logo' },
    ]);
  });

  it('uses Billede as description when alt is absent', () => {
    const result = detectImportedTargets('<img src="https://example.com/photo.jpg">');
    expect(result.images).toEqual([
      { src: 'https://example.com/photo.jpg', description: 'Billede' },
    ]);
  });

  it('uses Billede as description when alt is empty string', () => {
    const result = detectImportedTargets('<img src="https://example.com/photo.jpg" alt="">');
    expect(result.images).toEqual([
      { src: 'https://example.com/photo.jpg', description: 'Billede' },
    ]);
  });

  it('deduplicates images by src', () => {
    const result = detectImportedTargets(
      '<img src="https://example.com/logo.png" alt="Logo"><img src="https://example.com/logo.png" alt="Again">',
    );
    expect(result.images.length).toBe(1);
    // First occurrence wins for description too
    expect(result.images[0].description).toBe('Logo');
  });

  it('extracts multiple distinct images', () => {
    const result = detectImportedTargets(
      '<img src="https://example.com/a.png" alt="First"><img src="https://example.com/b.png" alt="Second">',
    );
    expect(result.images.length).toBe(2);
    const srcs = result.images.map(i => i.src);
    expect(srcs).toContain('https://example.com/a.png');
    expect(srcs).toContain('https://example.com/b.png');
  });

  it('handles img tags without src gracefully', () => {
    const result = detectImportedTargets('<img alt="No src here">');
    // No valid src — nothing added
    expect(result.images).toEqual([]);
  });
});

describe('detectImportedTargets — button detection', () => {
  it('extracts <a> elements with a colored background as buttons', () => {
    const html =
      '<a href="#" style="background:#1877f2;padding:10px;color:#fff">Find me on Facebook</a>' +
      '<a href="#" style="background-color:#4a90b8;padding:10px;color:#fff">Let\'s connect!</a>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([
      { text: 'Find me on Facebook', bgColor: '#1877f2' },
      { text: "Let's connect!", bgColor: '#4a90b8' },
    ]);
  });

  it('skips <a> with transparent/white/none backgrounds', () => {
    const html =
      '<a href="#" style="background:transparent">x</a>' +
      '<a href="#" style="background:#ffffff">y</a>' +
      '<a href="#" style="background:none">z</a>' +
      '<a href="#" style="background:white">w</a>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([]);
  });

  it('skips <a> with no style attribute', () => {
    const html = '<a href="#">just a link</a>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([]);
  });

  it('strips nested tags from the button text', () => {
    const html = '<a href="#" style="background:#000"><b>Bold</b> button</a>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([{ text: 'Bold button', bgColor: '#000' }]);
  });

  it('dedupes buttons by text', () => {
    const html =
      '<a href="#" style="background:#000">Click me</a>' +
      '<a href="#" style="background:#fff000">Click me</a>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([{ text: 'Click me', bgColor: '#000' }]);
  });

  it('detects <td> cells with colored backgrounds (Outlook-style table buttons)', () => {
    const html =
      '<table><tr><td style="background:#1877f2;padding:10px"><a href="#">Find me on Facebook</a></td></tr></table>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toContainEqual({ text: 'Find me on Facebook', bgColor: '#1877f2' });
  });

  it('detects <td> via legacy bgcolor attribute', () => {
    const html = '<table><tr><td bgcolor="#1877f2">Click here</td></tr></table>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toContainEqual({ text: 'Click here', bgColor: '#1877f2' });
  });

  it('detects <div> with a colored background as a button', () => {
    const html = '<div style="background:#0a66c2;padding:10px;color:#fff">In Lets connect</div>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toContainEqual({ text: 'In Lets connect', bgColor: '#0a66c2' });
  });

  it('rejects elements with text longer than 80 chars (probably containers, not buttons)', () => {
    const longText = 'a'.repeat(120);
    const html = `<div style="background:#000">${longText}</div>`;
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([]);
  });

  it('skips single-char button candidates (those live in glyphs already)', () => {
    const html = '<span style="background:#1877f2">f</span>';
    const result = detectImportedTargets(html);
    expect(result.buttons).toEqual([]);
    expect(result.glyphs).toContain('f');
  });
});

describe('detectImportedTargets — combined HTML', () => {
  it('correctly separates words and images from realistic signature HTML', () => {
    const html = `
      <table>
        <tr>
          <td><img src="https://example.com/logo.png" alt="Firma Logo"></td>
          <td>
            <div><b>Albert Hangaard</b></div>
            <div>CEO, <a href="mailto:albert@firma.dk">albert@firma.dk</a></div>
            <div>+45 12 34 56 78</div>
          </td>
        </tr>
      </table>
    `;
    const result = detectImportedTargets(html);
    expect(result.words).toContain('Albert');
    expect(result.words).toContain('Hangaard');
    expect(result.words).toContain('CEO');
    // Email shown as visible text content IS bindable. The href attribute
    // value is still excluded — but here the email is also a text node
    // inside the <a>, so it appears in the candidates list.
    expect(result.words).toContain('albert@firma.dk');
    expect(result.images).toEqual([
      { src: 'https://example.com/logo.png', description: 'Firma Logo' },
    ]);
  });
});
