// src/lib/mail-signature/__tests__/template.test.ts
import { renderSignature, escapeWithBrBreaks, bodyToParagraphs } from '../template';
import { EMPTY_SIGNATURE, SignatureData } from '../types';

const fullData: SignatureData = {
  name: 'Albert Hangaard',
  title: 'CEO',
  company: 'Zolva',
  phone: '+45 12 34 56 78',
  email: 'albert@zolva.io',
  website: 'zolva.io',
  customLines: 'CVR 12345678\nFortroligt',
  logo: { base64: 'AAAA', mimeType: 'image/png', width: 120, height: 40 },
};

describe('renderSignature', () => {
  it('returns null when every field is empty and no logo', () => {
    expect(renderSignature(EMPTY_SIGNATURE)).toBeNull();
  });

  it('renders just the name when only name is set', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'Albert' });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('<strong>Albert</strong>');
    expect(out!.image).toBeNull();
    expect(out!.plaintext).toBe('Albert');
  });

  it('renders the full signature with image and customLines', () => {
    const out = renderSignature(fullData);
    expect(out).not.toBeNull();
    expect(out!.html).toContain('<strong>Albert Hangaard</strong>');
    expect(out!.html).toContain(' · CEO');
    expect(out!.html).toContain('Zolva');
    expect(out!.html).toContain('T: +45 12 34 56 78');
    expect(out!.html).toContain('mailto:albert@zolva.io');
    expect(out!.html).toContain('https://zolva.io');
    expect(out!.html).toContain('CVR 12345678<br>Fortroligt');
    expect(out!.html).toContain('<img src="cid:zolva-sig"');
    expect(out!.html).toContain('width="120"');
    expect(out!.image).toEqual({ contentId: 'zolva-sig', bytes: 'AAAA', mimeType: 'image/png' });
  });

  it('renders only the logo when text fields are empty', () => {
    const out = renderSignature({
      ...EMPTY_SIGNATURE,
      logo: { base64: 'BBBB', mimeType: 'image/jpeg', width: 200, height: 50 },
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('cid:zolva-sig');
    expect(out!.image?.mimeType).toBe('image/jpeg');
  });

  it('escapes HTML entities in user input', () => {
    const out = renderSignature({
      ...EMPTY_SIGNATURE,
      name: '<script>alert(1)</script>',
      customLines: 'A & B',
    });
    expect(out!.html).not.toContain('<script>');
    expect(out!.html).toContain('&lt;script&gt;');
    expect(out!.html).toContain('A &amp; B');
  });

  it('prefixes website with https:// when no scheme present', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'A', website: 'zolva.io' });
    expect(out!.html).toContain('href="https://zolva.io"');
  });

  it('preserves existing scheme on website', () => {
    const out = renderSignature({ ...EMPTY_SIGNATURE, name: 'A', website: 'http://zolva.io' });
    expect(out!.html).toContain('href="http://zolva.io"');
  });

  it('renders only customLines when no other fields are set', () => {
    const out = renderSignature({
      ...EMPTY_SIGNATURE,
      customLines: 'Disclaimer\nLine 2',
    });
    expect(out).not.toBeNull();
    expect(out!.html).toContain('Disclaimer<br>Line 2');
    expect(out!.html).not.toContain('<strong>');
    expect(out!.html).not.toContain('mailto:');
    expect(out!.image).toBeNull();
    expect(out!.plaintext).toBe('Disclaimer\nLine 2');
  });
});

describe('escapeWithBrBreaks', () => {
  it('escapes entities and converts \\n to <br>', () => {
    expect(escapeWithBrBreaks('A & B\nC')).toBe('A &amp; B<br>C');
  });
});

describe('bodyToParagraphs', () => {
  it('splits paragraphs on \\n\\n+ and uses <br> for single \\n', () => {
    expect(bodyToParagraphs('para1 line1\npara1 line2\n\npara2')).toBe(
      '<p>para1 line1<br>para1 line2</p><p>para2</p>',
    );
  });

  it('escapes HTML in body content', () => {
    expect(bodyToParagraphs('<b>x</b>')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('returns empty paragraph for empty input', () => {
    expect(bodyToParagraphs('')).toBe('<p></p>');
  });
});
