// src/lib/mail-signature/__tests__/detect-targets.test.ts
import { detectImportedTargets } from '../detect-targets';

describe('detectImportedTargets — invalid / empty input', () => {
  it('returns empty arrays for empty string', () => {
    expect(detectImportedTargets('')).toEqual({ words: [], images: [] });
  });

  it('returns empty arrays for null input', () => {
    expect(detectImportedTargets(null as unknown as string)).toEqual({ words: [], images: [] });
  });

  it('returns empty arrays for numeric input', () => {
    expect(detectImportedTargets(42 as unknown as string)).toEqual({ words: [], images: [] });
  });

  it('returns empty arrays for object input', () => {
    expect(detectImportedTargets({} as unknown as string)).toEqual({ words: [], images: [] });
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

  it('filters out tokens shorter than 3 chars', () => {
    const result = detectImportedTargets('Hi me you long');
    expect(result.words).not.toContain('Hi');
    expect(result.words).not.toContain('me');
    expect(result.words).toContain('you');
    expect(result.words).toContain('long');
  });

  it('filters out pure-numeric tokens', () => {
    const result = detectImportedTargets('Call 12345 now or 999');
    expect(result.words).not.toContain('12345');
    expect(result.words).not.toContain('999');
    expect(result.words).toContain('Call');
    expect(result.words).toContain('now');
  });

  it('strips trailing punctuation from words', () => {
    const result = detectImportedTargets('her. og, men; dig:');
    expect(result.words).toContain('her');
    expect(result.words).toContain('men');
    // "og" is 2 chars — filtered; "dig" is 3 chars — kept
    expect(result.words).not.toContain('og');
    expect(result.words).toContain('dig');
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

  it('caps word list at 20 entries', () => {
    // Generate HTML with 30 distinct words
    const manyWords = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ');
    const result = detectImportedTargets(manyWords);
    expect(result.words.length).toBeLessThanOrEqual(20);
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
    // Email address in href should NOT appear as words
    expect(result.words.some(w => w.includes('@'))).toBe(false);
    expect(result.images).toEqual([
      { src: 'https://example.com/logo.png', description: 'Firma Logo' },
    ]);
  });
});
