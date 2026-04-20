export const NETWORK_TIMEOUT_MS = 15_000;

export class NetworkTimeoutError extends Error {
  readonly provider: 'google' | 'microsoft';
  constructor(provider: 'google' | 'microsoft', message?: string) {
    super(message ?? `${provider} request timed out after ${NETWORK_TIMEOUT_MS}ms`);
    this.name = 'NetworkTimeoutError';
    this.provider = provider;
  }
}

// fetch wrapper that aborts after NETWORK_TIMEOUT_MS and rethrows any
// abort as a typed NetworkTimeoutError. Callers that already pass their own
// AbortSignal are respected: the timeout is linked to the caller's signal.
export async function fetchWithTimeout(
  provider: 'google' | 'microsoft',
  input: RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  const upstream = init?.signal;
  const onUpstreamAbort = () => controller.abort();
  upstream?.addEventListener('abort', onUpstreamAbort);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (upstream?.aborted) throw err;
    if (controller.signal.aborted) throw new NetworkTimeoutError(provider);
    throw err;
  } finally {
    clearTimeout(timeout);
    upstream?.removeEventListener('abort', onUpstreamAbort);
  }
}
