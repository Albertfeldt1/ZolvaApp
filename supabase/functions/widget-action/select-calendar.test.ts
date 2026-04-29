import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { selectCalendar, type LabelMap, type Selection } from './select-calendar.ts';

const W: LabelMap['work'] = { provider: 'google', id: 'work@gmail.com' };
const P: LabelMap['personal'] = { provider: 'microsoft', id: 'home@outlook.com' };

Deno.test('hint matches and label is configured', () => {
  const sel = selectCalendar({ hint: 'work', labels: { work: W, personal: P } });
  assertEquals<Selection>(sel, {
    target: W,
    resolution: 'hint_matched',
    fallbackFromLabel: null,
    usedLabel: 'work',
  });
});

Deno.test('hint requested but only other label configured -> fallback', () => {
  const sel = selectCalendar({ hint: 'work', labels: { personal: P } });
  assertEquals<Selection>(sel, {
    target: P,
    resolution: 'fallback_only_configured',
    fallbackFromLabel: 'work',
    usedLabel: 'personal',
  });
});

Deno.test('no hint + personal configured -> label_default', () => {
  const sel = selectCalendar({ hint: null, labels: { personal: P } });
  assertEquals<Selection>(sel, {
    target: P,
    resolution: 'label_default',
    fallbackFromLabel: null,
    usedLabel: 'personal',
  });
});

Deno.test('no hint + only work configured -> fallback_only_configured', () => {
  const sel = selectCalendar({ hint: null, labels: { work: W } });
  assertEquals<Selection>(sel, {
    target: W,
    resolution: 'fallback_only_configured',
    fallbackFromLabel: null,
    usedLabel: 'work',
  });
});

Deno.test('no hint + both configured -> personal default', () => {
  const sel = selectCalendar({ hint: null, labels: { work: W, personal: P } });
  assertEquals(sel.target, P);
  assertEquals(sel.resolution, 'label_default');
});

Deno.test('hint matches Personal exactly', () => {
  const sel = selectCalendar({ hint: 'personal', labels: { work: W, personal: P } });
  assertEquals(sel.target, P);
  assertEquals(sel.resolution, 'hint_matched');
});

Deno.test('caller responsibility: both empty is unreachable here', () => {
  // selectCalendar is documented to assume at least one label is configured;
  // empty-labels exit happens earlier in the pipeline. Sanity-check the
  // function returns null target without crashing in the unexpected case.
  const sel = selectCalendar({ hint: null, labels: {} });
  assertEquals(sel.target, null);
});
