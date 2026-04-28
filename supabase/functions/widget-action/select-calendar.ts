export type CalendarLabelTarget = { provider: 'google' | 'microsoft'; id: string };

export type LabelMap = {
  work?: CalendarLabelTarget;
  personal?: CalendarLabelTarget;
};

export type Resolution =
  | 'hint_matched'
  | 'fallback_only_configured'
  | 'label_default'
  | 'no_calendar';

export type Selection = {
  target: CalendarLabelTarget | null;
  resolution: Resolution;
  /**
   * When `resolution === 'fallback_only_configured'` AND the user requested a
   * label hint that wasn't configured, this names the requested-but-missing
   * label. Used by the dialog formatter to add "du har ikke valgt en
   * {fallbackFromLabel}-kalender endnu" copy. Null otherwise.
   */
  fallbackFromLabel: 'work' | 'personal' | null;
  usedLabel: 'work' | 'personal' | null;
};

export function selectCalendar(args: {
  hint: 'work' | 'personal' | null;
  labels: LabelMap;
}): Selection {
  const { hint, labels } = args;

  // 1. Hint matched.
  if (hint && labels[hint]) {
    return {
      target: labels[hint]!,
      resolution: 'hint_matched',
      fallbackFromLabel: null,
      usedLabel: hint,
    };
  }

  // 2. Hint requested but only the OTHER label configured → fall back.
  if (hint) {
    const other = hint === 'work' ? 'personal' : 'work';
    if (labels[other]) {
      return {
        target: labels[other]!,
        resolution: 'fallback_only_configured',
        fallbackFromLabel: hint,
        usedLabel: other,
      };
    }
  }

  // 3. No hint, Personal configured → default to Personal.
  if (!hint && labels.personal) {
    return {
      target: labels.personal,
      resolution: 'label_default',
      fallbackFromLabel: null,
      usedLabel: 'personal',
    };
  }

  // 4. No hint, only Work configured → fall back to Work.
  if (!hint && labels.work) {
    return {
      target: labels.work,
      resolution: 'fallback_only_configured',
      fallbackFromLabel: null,
      usedLabel: 'work',
    };
  }

  // 5. Unreachable from the live pipeline (caller exits on empty labels).
  return { target: null, resolution: 'no_calendar', fallbackFromLabel: null, usedLabel: null };
}
