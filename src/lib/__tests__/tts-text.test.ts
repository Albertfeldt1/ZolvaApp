import { stripForSpeech } from '../tts-text';

describe('stripForSpeech', () => {
  it('fjerner fed og kursiv markdown', () => {
    expect(stripForSpeech('Du har **3 møder** i dag, *heraf* ét vigtigt.')).toBe(
      'Du har 3 møder i dag, heraf ét vigtigt.',
    );
  });

  it('læser link-labels i stedet for adresser', () => {
    expect(stripForSpeech('Se [dagsordenen](https://example.com/x?y=1) her.')).toBe('Se dagsordenen her.');
  });

  it('erstatter rå URL’er med "link"', () => {
    expect(stripForSpeech('Mødelink: https://meet.example.com/abc-defg-hij')).toBe('Mødelink: link');
  });

  it('fjerner overskrifter, punkttegn og code ticks', () => {
    const md = '## I dag\n- Møde kl. 10\n- Ring til `Mette`';
    expect(stripForSpeech(md)).toBe('I dag\nMøde kl. 10\nRing til Mette');
  });

  it('bevarer almindelig dansk tekst urørt', () => {
    expect(stripForSpeech('Dit næste møde er kl. 13.30 med Søren.')).toBe(
      'Dit næste møde er kl. 13.30 med Søren.',
    );
  });

  it('returnerer tom streng for tomt/whitespace-input', () => {
    expect(stripForSpeech('   \n  ')).toBe('');
  });
});
