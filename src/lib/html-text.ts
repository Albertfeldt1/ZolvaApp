// Delt HTML→tekst-konvertering til mail-bodies (L14).
//
// Erstatter to duplikerede regex-strippere i gmail.ts og microsoft-graph.ts,
// som lækkede markup i eksotiske mails. Stadig regex-baseret (ingen
// DOM-parser i RN), men hærdet mod de kendte huller:
//  - tags med '>' inde i citerede attributter ("<img alt=\"x > y\">")
//  - ulukkede <style>/<script>-blokke, der lod rå CSS/JS slippe igennem
//  - navngivne entities ud over grundsettet — især danske (&oslash; &aring;)
//  - hex-numeriske entities (&#x27;) og kodepunkter uden for BMP

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  aelig: 'æ',
  oslash: 'ø',
  aring: 'å',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  deg: '°',
  middot: '·',
  bull: '•',
  sect: '§',
  times: '×',
  shy: '',
  zwnj: '',
  zwj: '',
};

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
        if (body.startsWith('#')) {
          const hex = body[1] === 'x' || body[1] === 'X';
          const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
          try {
            return String.fromCodePoint(code);
          } catch {
            return '';
          }
        }
        // &amp; dekodes SIDST (nedenfor) — ellers bliver dobbelt-encodede
        // sekvenser som "&amp;lt;" fejlagtigt til "<".
        if (body.toLowerCase() === 'amp') return match;
        const hit = NAMED_ENTITIES[body.toLowerCase()];
        if (hit === undefined) return match; // ukendt entity: lad stå som tekst
        // Store bogstaver på dansk/tysk: &Oslash; → Ø, &Aring; → Å, &Uuml; → Ü.
        const wantsUpper = body[0] === body[0].toUpperCase();
        return wantsUpper && hit.length === 1 ? hit.toUpperCase() : hit;
      })
      .replace(/&amp;/gi, '&')
  );
}

/** Konvertér en HTML-mailbody til læsbar ren tekst. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      // Container-blokke hvis INDHOLD aldrig er brødtekst. `|$` dropper en
      // ulukket blok til slutningen i stedet for at lade rå CSS/JS slippe ud.
      .replace(/<(style|script|head|noscript|title|svg)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      // Adjacent close+open of block containers is ONE line break - without
      // this collapse, both tags below emit \n and every line in a
      // div-per-line signature/body ends up double-spaced.
      .replace(/<\/(?:p|div|h[1-6]|li|tr|td|section|article)>\s*<(?:p|div|h[1-6]|li|tr|section|article)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|td|section|article)>/gi, '\n')
      // Opening block tags break too: Gmail signatures are shaped like
      // "Venlig hilsen.<div>Oscar</div>" - only breaking on the CLOSE glued
      // the salutation onto the name ("Venlig hilsen.Oscar").
      .replace(/<(?:p|div|h[1-6]|li|tr|section|article)\b[^>]*>/gi, '\n')
      // Attribut-bevidst tag-strip: citerede attributter må indeholde '>'
      // uden at tagget "lukker" for tidligt og lækker resten som tekst.
      .replace(/<\/?[a-zA-Z][^"'<>]*(?:(?:"[^"]*"|'[^']*')[^"'<>]*)*\/?>/g, '')
      // Sidste fejemand for misdannede tags, samme som den gamle stripper.
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
