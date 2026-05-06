# iCloud send & draft — design

**Date:** 2026-05-06
**Status:** approved, ready for implementation plan
**Author:** Albert + Claude

## Goal

Let users with only an iCloud account use the `create_draft` and `send_mail` chat tools end-to-end. Today both tools hard-reject `provider: 'icloud'` with a Danish "not supported yet" message. After this change, an iCloud-only user can ask Zolva to send a mail or save a draft, and it works the same way it does for Gmail and Outlook users.

No new user-facing UI. The chat surface is unchanged — only the underlying tools learn a third provider.

## Why now

The 2026-04-25 iCloud mail/calendar design shipped read-only iCloud mail. Allan (and any iCloud-only user) can read mail in Zolva but has to switch to Apple Mail to reply or send. With send and draft wired up, iCloud reaches feature-parity with the other two providers and the agent becomes useful for iCloud-only users instead of being a glorified inbox viewer.

## Non-goals

- HTML mail bodies. Plain text only; Danish UTF-8 via quoted-printable.
- Attachments.
- Send-from alias picker (e.g. choosing between `@me.com` / `@icloud.com` / custom domain). v1 sends from whatever email Allan entered in `IcloudSetupScreen`.
- BCC. CC only. (Easy to add later if needed; deferred to keep schema and UX minimal.)
- iCloud calendar invites / iTIP — already deferred from the read design.

## Architecture summary

Two new ops on the existing `imap-proxy` Supabase edge function:

- **`send-mail`** — connects to `smtp.mail.me.com:587` via STARTTLS using denomailer, sends an RFC 5322 message, then best-effort IMAP-`APPEND`s a copy to the Sent folder.
- **`append-draft`** — builds the same RFC 5322 message but does not send; IMAP-`APPEND`s it directly to the `Drafts` folder with the `\Draft` flag.

Both reuse the function's existing JWT gate, binding-row hash check, rate-limit table (`icloud_proxy_calls`), and lazy-load pattern (`imapflow` only loaded when needed; `denomailer` joins it).

Client side, `runMailComposeTool` in `src/lib/hooks.ts` gains an iCloud branch that mirrors the Microsoft branch — schema enums widen, the `'iCloud not supported'` rejection in `parseMailComposeInput` is removed, and two new exports from `src/lib/icloud-mail.ts` (`icloudSendMail`, `icloudAppendDraft`) wrap the proxy calls. SWR inbox cache is invalidated on success.

## Component design

### 1. Surface — `src/lib/hooks.ts`

Three changes only:

- `MAIL_COMPOSE_SCHEMA` for both `create_draft` and `send_mail`: provider enum becomes `['google', 'microsoft', 'icloud']`.
- Tool descriptions: drop the `iCloud understøttes ikke` sentences from both descriptions.
- `MailComposeProvider` type adds `'icloud'`. `parseMailComposeInput` accepts it (the rejection branch goes away entirely).

### 2. Server — `supabase/functions/imap-proxy/index.ts`

#### `op: 'send-mail'`

Request:

```ts
{
  op: 'send-mail';
  email: string;
  password: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;          // plain text, signature already appended client-side
  reply_to_uid?: number; // IMAP UID of original mail in INBOX
}
```

Flow:

1. JWT gate, body-shape validation, binding-row hash check (same pattern as `list-inbox` / `get-body`).
2. Rate-limit check on a new bucket (`RATE_LIMIT_SEND_MAIL = 30/hr`).
3. If `reply_to_uid` is set:
   - Lazy-load imapflow if not already cached.
   - LOGIN, EXAMINE INBOX (read-only — keeps `\Seen` clean), `FETCH <uid> (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES SUBJECT FROM)])`, LOGOUT.
   - Build the threading strings: `inReplyTo = messageIdHeader`, `references = (origReferences ? origReferences + ' ' : '') + messageIdHeader`.
   - On any failure (UID gone, IMAP error, timeout): warn-log, continue without threading. Don't fail the whole call — the user's intent is "send the mail," and an unthreaded send is strictly better than a rejected one.
4. Lazy-load denomailer. Connect to `smtp.mail.me.com:587`, STARTTLS, AUTH PLAIN with `email` + `password`. Send the message with the threading headers (if any). Connection timeout 5s, command timeout 10s — same constants as IMAP path.
5. On SMTP success, best-effort IMAP `APPEND` to the Sent folder:
   - Open a fresh IMAP connection (denomailer doesn't share with imapflow).
   - Resolve the Sent folder name by trying in order: `Sent Messages`, `Sent`, then any folder reported with the `\Sent` special-use flag.
   - APPEND the just-sent message with `\Seen` flag set.
   - LOGOUT.
   - Wrapped in try/catch. On failure, warn-log. Response still returns `{ ok: true }`.
6. Return `{ ok: true, sent_appended: boolean }` on success.

Error mapping:

| Failure | Code | Status |
|---|---|---|
| denomailer auth (SMTP 535) | `auth-failed` | 401 |
| denomailer connect / DNS / TCP | `network` | 502 |
| denomailer command timeout | `timeout` | 504 |
| denomailer protocol (rejected recipient, message too large, 5xx response) | `protocol` (with truncated detail) | 502 |
| denomailer dependency load failure | `internal` | 500 |
| Reply-header FETCH failure | logged only, send proceeds | — |
| Sent APPEND failure | logged only, response still 200 | — |

#### `op: 'append-draft'`

Request: same shape as `send-mail` minus `reply_to_uid` is optional and used only for embedding threading headers into the stored draft.

Flow:

1. JWT gate, body-shape validation, binding-row hash check.
2. Rate-limit check on a new bucket (`RATE_LIMIT_APPEND_DRAFT = 60/hr`).
3. If `reply_to_uid` set: same header fetch as `send-mail` step 3, with the same fail-soft behavior.
4. Build the RFC 5322 message via denomailer's message builder (do not call `send`). This guarantees identical encoding (UTF-8 quoted-printable) between drafts and sent mail.
5. IMAP LOGIN, locate the Drafts folder (try `Drafts`, then `\Drafts` special-use flag), APPEND with the `\Draft` flag, LOGOUT.
6. Return `{ ok: true }`.

Errors map the same way as `send-mail`, minus the SMTP-specific ones — IMAP failures during the APPEND map to `protocol` (not `network`) since the connection succeeded.

#### Rate-limit table updates

Both new ops are accounted in `icloud_proxy_calls` like the existing ops. `checkRateLimit` adds two new buckets:

```ts
const RATE_LIMIT_SEND_MAIL = 30;     // per hour per user
const RATE_LIMIT_APPEND_DRAFT = 60;  // per hour per user
```

Send is conservatively below Apple's per-account SMTP throttle. Draft is cheaper and shares the order-of-magnitude with `list-inbox`.

#### Cold-start

`denomailer` lazy-loads on first `send-mail` call per worker, mirroring the existing `imapflow` lazy-load. The pg_cron `ping` keep-warm continues to skip it (cheaper to pay one cold-start when the user actually sends than to load both libs on every ping).

### 3. Client — `src/lib/icloud-mail.ts` and `src/lib/hooks.ts`

#### New exports in `src/lib/icloud-mail.ts`

```ts
export type IcloudComposeInput = {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  replyToUid?: number;
};

export async function icloudSendMail(input: IcloudComposeInput): Promise<void>;
export async function icloudAppendDraft(input: IcloudComposeInput): Promise<void>;
```

Both call a shared `callIcloudProxy` helper (already used by the read paths) with the new ops. Credentials come from the existing `getIcloudCredentials()` flow — same path the read ops use, including the credential-expired UI hook on `auth-failed`.

On success, both call the SWR cache invalidator (s5934) so the inbox view refreshes next time it's read.

#### `runMailComposeTool` in `src/lib/hooks.ts`

The iCloud branch parallels the Microsoft branch:

```ts
if (provider === 'icloud' && !ctx.icloudMail) {
  return {
    text: 'Brugeren har ikke forbundet en iCloud-konto. Foreslå at forbinde iCloud under Indstillinger.',
    isError: true,
  };
}
```

Reply ID resolution reuses the existing `splitUnifiedId` + provider-mismatch guard. For iCloud, the `providerReplyId` is the IMAP UID as a string; we cast it via `Number(...)`. If the cast yields `NaN`, return `'Ugyldigt iCloud reply-ID.'`.

Dispatch:

```ts
if (provider === 'icloud') {
  if (name === 'create_draft') {
    await icloudAppendDraft({ to, cc, subject, body, replyToUid: providerReplyIdNum });
    return { text: 'Udkast oprettet i iCloud.', isError: false };
  }
  await icloudSendMail({ to, cc, subject, body, replyToUid: providerReplyIdNum });
  return {
    text: providerReplyIdNum ? 'Svaret er sendt fra iCloud.' : 'Mailen er sendt fra iCloud.',
    isError: false,
  };
}
```

#### Signature

The signature is appended to `body` upstream of `runMailComposeTool` for Gmail and Outlook. During implementation, verify the signature path applies for iCloud too. If a provider gate exists around signature loading, lift it (one-line fix). No design change — flagged as a check item.

### 4. Error handling

The client-facing Danish strings in `runMailComposeTool` map the proxy error codes:

| Code | Surface |
|---|---|
| `auth-failed` | "Apple afviste login. Din app-specific password er måske udløbet — opdater under Indstillinger." Also triggers the existing expired-credential UI (integration-flag flip). |
| `protocol` | "iCloud SMTP afviste afsendelsen: \<detail\>" (detail is the truncated SMTP error). |
| `rate-limited` | "For mange iCloud-mails sendt fra Zolva i dag. Prøv igen om en time." |
| `network` / `timeout` / `temporarily-unavailable` | "iCloud kunne ikke nås. Prøv igen om lidt." |
| Other | "iCloud afviste afsendelsen." |

The auth-failed → expired-credential UI flip is op-agnostic in `icloud-credentials.ts` today, but the new ops must be wired into whatever switch / list of ops it consults.

### 5. System prompt

Grep for any existing guidance steering the model away from iCloud for compose (e.g. "iCloud kan ikke sende"). Remove. The model can now treat all three providers symmetrically.

## Data flow

**Send (no reply):**

```
chat → send_mail({provider: 'icloud', to, subject, body})
  → runMailComposeTool → icloudSendMail
    → callIcloudProxy('send-mail', {…})
      → edge function: rate-check → SMTP send → best-effort IMAP APPEND to Sent
    ← {ok: true, sent_appended: true}
  ← void
← "Mailen er sendt fra iCloud."
+ inbox cache invalidate
```

**Send (reply):**

```
chat → send_mail({provider: 'icloud', reply_to_id: 'icloud:12345', …})
  → splitUnifiedId → providerReplyIdNum = 12345
  → icloudSendMail({…, replyToUid: 12345})
    → edge function:
      → IMAP fetch headers for UID 12345 → Message-ID, References
      → SMTP send with In-Reply-To + References headers
      → best-effort APPEND to Sent
```

**Draft:**

```
chat → create_draft({provider: 'icloud', …})
  → icloudAppendDraft → callIcloudProxy('append-draft', …)
    → edge function:
      → (optional) IMAP fetch reply headers
      → build RFC 5322 message
      → IMAP APPEND to Drafts folder with \Draft flag
```

## Testing

No automated test harness for edge functions or the chat tool layer exists in this codebase. Manual E2E only:

**Server side (against deployed function):**

- Plain ASCII send Allan → himself, confirm receipt and Sent folder copy in Apple Mail.
- Danish characters: subject and body with `æ ø å`, confirm correct rendering on receipt.
- Reply threading: send reply with `reply_to_uid`, confirm Apple Mail threads it (not a new conversation).
- Sent-folder edge case: rename `Sent Messages` server-side → confirm SMTP send succeeds, APPEND silently fails, response still 200.
- Auth failure: send with wrong password → confirm `auth-failed` surfaces and triggers the expired-credential UI.
- Draft: APPEND a draft → confirm Apple Mail shows it in Drafts and lets you finish/send.

**Client side (in-app via chat):**

- "Send en mail til X med emnet Y og teksten Z" → tool fires with `provider: 'icloud'` when iCloud is the only connected provider.
- "Lav et udkast..." → `create_draft` fires, not `send_mail`.
- Reply flow: open an iCloud mail, "svar at jeg er enig" → threading preserved.
- Provider-gated readiness: disconnect iCloud, attempt send → Danish "ikke forbundet" message.

**Stretch (only if cheap):** integration test against a fake SMTP server exercising encoding + threading. Skip if denomailer doesn't ship a usable test helper.

## Rollout

Per the project's server-first cycle:

1. Commit and deploy the edge-function changes alone. Ship before any client changes — the new ops should exist (and be safe) before the client tries to call them.
2. Commit and OTA-ship the client changes. The schema widening, lib exports, and `runMailComposeTool` branch all land together.
3. Keep the rollout testable: the edge function stays backwards-compatible with the existing client (it gains ops; existing ops are untouched), and the client can be reverted independently if a bug surfaces.

## Open questions

None — design is fully resolved. Implementation may surface incidentals (Sent folder name on a particular Apple ID, denomailer EHLO compatibility) handled by the fail-soft paths above.
