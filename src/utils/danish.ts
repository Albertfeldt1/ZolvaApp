export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export type ProviderErrorKind = 'auth' | 'network' | 'permission' | 'rate-limit' | 'unknown';

export type TranslatedError = {
  message: string;
  kind: ProviderErrorKind;
};

export function translateProviderError(error: unknown): TranslatedError {
  const rawOriginal = extractMessage(error);
  const raw = rawOriginal.toLowerCase();

  if (!raw) {
    return { message: 'Noget gik galt. Prøv igen.', kind: 'unknown' };
  }

  // An AADSTS code (Azure AD) is the single most actionable signal, so surface
  // it BEFORE any of the naive substring buckets below. Those buckets would
  // otherwise hide it: the `401/invalid_grant` branch masks a redirect-mismatch
  // (AADSTS50011 comes back as invalid_grant) behind the generic "udløbet" copy,
  // and the 5xx branch false-matches the digits inside the code itself (e.g.
  // "AADSTS65001" contains "500"). Microsoft connect failures bounce back from
  // login.microsoftonline.com without ever touching our server, so this dialog
  // is the only place the code is visible - it must not be swallowed.
  const aadStsTop = rawOriginal.match(/AADSTS\d+/i);
  if (aadStsTop) {
    return {
      message:
        `Microsoft afviste forbindelsen (${aadStsTop[0].toUpperCase()}). ` +
        'Vis denne besked til support, hvis det bliver ved.',
      kind: 'auth',
    };
  }

  if (
    raw.includes('network request failed') ||
    raw.includes('network error') ||
    raw.includes('fetch failed') ||
    raw.includes('enotfound') ||
    raw.includes('econnrefused') ||
    raw.includes('timeout') ||
    raw.includes('timed out') ||
    raw.includes('offline')
  ) {
    return { message: 'Ingen forbindelse - prøv igen.', kind: 'network' };
  }

  if (raw.includes('invalid login credentials')) {
    return { message: 'Forkert email eller adgangskode.', kind: 'auth' };
  }

  if (raw.includes('email not confirmed')) {
    return { message: 'Du skal bekræfte din mail, før du kan logge ind.', kind: 'auth' };
  }

  if (raw.includes('user already registered') || raw.includes('already registered')) {
    return { message: 'Der findes allerede en konto med den mail.', kind: 'auth' };
  }

  if (
    raw.includes('identity is already linked') ||
    raw.includes('identity_already_exists')
  ) {
    return {
      message:
        'Den konto er allerede tilknyttet en anden bruger. Log ud og log ind med Google/Microsoft i stedet.',
      kind: 'auth',
    };
  }

  if (
    raw.includes('401') ||
    raw.includes('unauthorized') ||
    raw.includes('invalid_grant') ||
    raw.includes('token expired') ||
    raw.includes('jwt expired') ||
    raw.includes('refresh token')
  ) {
    return {
      message: 'Din forbindelse er udløbet. Log ud og forbind igen.',
      kind: 'auth',
    };
  }

  if (raw.includes('403') || raw.includes('forbidden') || raw.includes('insufficient')) {
    return {
      message: 'Kunne ikke gennemføre - du mangler tilladelse hos udbyderen.',
      kind: 'permission',
    };
  }

  if (raw.includes('429') || raw.includes('rate limit') || raw.includes('too many requests')) {
    return { message: 'For mange forsøg lige nu. Prøv igen om lidt.', kind: 'rate-limit' };
  }

  if (raw.includes('gmail send failed') || raw.includes('smtp')) {
    return { message: 'Kunne ikke sende mailen. Prøv igen om lidt.', kind: 'unknown' };
  }

  // Supabase gotrue gateway error: the OAuth code was exchanged successfully
  // but the call to graph.microsoft.com /me (or Google equivalent) returned
  // no readable email/UPN claim - typically because the provider account has
  // no mail attribute exposed or the tenant suppresses the claim. The string
  // contains "500" so it must be matched BEFORE the generic 5xx catch-all,
  // otherwise users get the misleading "Tjenesten er utilgængelig - prøv igen
  // om lidt" copy and keep retrying the same broken account in a loop.
  if (raw.includes('external provider')) {
    return {
      message:
        'Vi kunne ikke hente din e-mail-adresse fra Microsoft eller Google. ' +
        'Det sker oftest når din arbejdskonto ikke har en e-mail tilknyttet, ' +
        'eller hvis administratoren begrænser hvad apps må læse. ' +
        'Prøv en anden konto, eller kontakt din IT-administrator.',
      kind: 'permission',
    };
  }

  if (raw.includes('500') || raw.includes('502') || raw.includes('503') || raw.includes('504')) {
    return { message: 'Tjenesten er utilgængelig lige nu. Prøv igen om lidt.', kind: 'unknown' };
  }

  // Fallthrough — surface a sanitized snippet of the raw error so a
  // user's support screenshot tells us what actually failed instead
  // of the same opaque "Noget gik galt." for every wrapped wrapper.
  // (AADSTS codes are handled at the top of this function so the naive
  // buckets above can't swallow them.)
  const looksDiagnostic =
    raw.includes('oauth') ||
    raw.includes('error_description') ||
    raw.includes('error=') ||
    raw.includes('identity') ||
    raw.includes('exchange') ||
    raw.includes('provider_token');
  if (looksDiagnostic) {
    const snippet = rawOriginal
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 120);
    return {
      message: `Noget gik galt. Prøv igen.\n\n(detalje: ${snippet})`,
      kind: 'unknown',
    };
  }

  return { message: 'Noget gik galt. Prøv igen.', kind: 'unknown' };
}

function extractMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    return typeof msg === 'string' ? msg : '';
  }
  return String(error);
}
