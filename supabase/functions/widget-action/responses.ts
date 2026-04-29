export type ErrorClass =
  | 'empty_prompt'
  | 'unparseable'
  | 'no_calendar_labels'
  | 'oauth_invalid'
  | 'permission_denied'
  | 'provider_5xx';

export type SnippetMood = 'happy' | 'worried';

export type WidgetActionResponse = {
  dialog: string;
  snippet: {
    mood: SnippetMood;
    summary: string;
    deepLink: string;
  };
};

export function emptyPrompt(): WidgetActionResponse {
  return {
    dialog: 'Hvad skulle jeg sætte op?',
    snippet: {
      mood: 'worried',
      summary: "Sig fx 'sæt et møde i morgen kl. 17'.",
      deepLink: 'zolva://chat',
    },
  };
}

export function unparseable(): WidgetActionResponse {
  return {
    dialog: 'Forstod ikke. Prøv igen i appen.',
    snippet: { mood: 'worried', summary: 'Forstod ikke', deepLink: 'zolva://chat' },
  };
}

export function noCalendarLabels(): WidgetActionResponse {
  return {
    dialog: 'Vælg en arbejds- eller privatkalender.',
    snippet: { mood: 'worried', summary: 'Vælg kalender', deepLink: 'zolva://settings' },
  };
}

export function oauthInvalid(provider: 'google' | 'microsoft' | 'icloud'): WidgetActionResponse {
  const providerName = providerDisplayName(provider);
  return {
    dialog: `Forbind ${providerName} igen.`,
    snippet: {
      mood: 'worried',
      summary: `${providerName} forbindelse udløbet`,
      deepLink: 'zolva://settings#calendars',
    },
  };
}

export function permissionDenied(calendarName: string): WidgetActionResponse {
  return {
    dialog: `Du har ikke skriverettigheder til ${calendarName}.`,
    snippet: {
      mood: 'worried',
      summary: `Skriverettigheder mangler: ${calendarName}`,
      deepLink: 'zolva://settings',
    },
  };
}

export function provider5xx(provider: 'google' | 'microsoft' | 'icloud'): WidgetActionResponse {
  const providerName = providerDisplayName(provider);
  return {
    dialog: `${providerName} svarede ikke. Prøv igen.`,
    snippet: {
      mood: 'worried',
      summary: `${providerName} fejl`,
      deepLink: 'zolva://chat',
    },
  };
}

function providerDisplayName(p: 'google' | 'microsoft' | 'icloud'): string {
  if (p === 'google')    return 'Google';
  if (p === 'microsoft') return 'Outlook';
  return 'iCloud';
}

export function loggedOut(): WidgetActionResponse {
  return {
    dialog: 'Logget ud — åbn Zolva for at logge ind igen.',
    snippet: { mood: 'worried', summary: 'Logget ud', deepLink: 'zolva://settings' },
  };
}
