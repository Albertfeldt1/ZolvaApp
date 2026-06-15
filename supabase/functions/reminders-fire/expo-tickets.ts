// Parses an Expo Push API response. The push endpoint returns HTTP 200 even
// when individual messages fail, with a per-ticket status array in the body.
// Tickets come back in the same order as the messages we sent, so they map
// 1:1 to the tokens array.
//
// We only prune tokens that failed with DeviceNotRegistered (the device
// uninstalled or revoked notifications) — transient errors (rate limits,
// Expo hiccups) must NOT delete a still-valid token.

export type ExpoTicket = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function parseDeadTokens(tokens: string[], responseBody: unknown): string[] {
  const data = (responseBody as { data?: ExpoTicket[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const dead: string[] = [];
  data.forEach((ticket, i) => {
    if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
      const token = tokens[i];
      if (token) dead.push(token);
    }
  });
  return dead;
}
