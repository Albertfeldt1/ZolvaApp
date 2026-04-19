# Inbox Detail + Real-Send Flow — Design

**Date:** 2026-04-19
**Status:** Approved, ready for implementation plan

## Goal

Turn the Inbox's inert rows into a working reply flow: tap a row → open a detail view → read the message body → edit the AI-generated draft → send as a real reply → automatically archive the original. Replaces today's read-only preview with a full send path on both Gmail and Microsoft Graph.

## Scope

In scope:

- Full-screen detail view for a single inbox message
- Fetching the message body on open (plain text)
- Editable multiline draft, pre-filled with the Claude draft when available
- Sending a reply in-thread via Gmail and Microsoft Graph
- Archiving + marking the original as read after successful send
- OAuth scope upgrades and the one-time re-consent path
- Optimistic UI update so the sent row disappears from "waiting" and appears in "cleared"

Out of scope for this pass:

- Thread history / prior-message rendering
- Subject or recipient editing (reply always goes to the original sender with `Re:` subject)
- Attachments (neither reading nor sending)
- Rich-text editing (plain text only)
- Cc / Bcc

## User Flow

1. User taps an inbox row in `InboxScreen`.
2. `InboxDetailScreen` slides in from below (matches `ChatScreen` overlay pattern).
3. Detail header shows sender, subject, relative time. Body fetches in the background; a subtle "Henter…" placeholder appears while loading.
4. Below the body, a multiline `TextInput` is pre-filled with the Claude draft (or empty if none was generated).
5. User can edit freely. Actions at the bottom:
   - **Send** — sends the reply, archives + marks-read the original, dismisses detail.
   - **Arkivér** — archives + marks-read without sending; dismisses detail.
   - **Luk** (back arrow in header) — dismisses with no side effect.
6. On send success: haptic confirmation, detail closes, inbox reflects the change (optimistic).
7. On send failure: inline error banner in detail, draft is preserved, user can retry or close.

## Architecture

### Navigation

The app has no navigation library — screen switching lives in `App.tsx` state. The detail view follows the existing `ChatScreen` pattern:

- New state in `App.tsx`: `selectedMailId: string | null`
- When set, `InboxDetailScreen` renders as a full-screen `Animated.View` with `SlideInDown` / `SlideOutDown`, above the tab chrome
- The bottom `PhoneChrome` is hidden while detail is open (same as chat)
- Dismissing sets `selectedMailId` back to `null`

`InboxScreen` receives an `onOpenMail(id: string)` prop and wires each row's `onPress` to it.

### Data layer

Both providers grow three capabilities: fetch body, reply, archive + mark-read. They keep the same shape as existing calls — wrapped in `tryWithRefresh`, throwing `ProviderAuthError` on 401/403 so the auto-refresh path in `auth.ts` handles scope/token issues.

New functions in `src/lib/gmail.ts`:

- `getMessageBody(id)` — `messages.get?format=full`, walks MIME parts, returns `{ text, threadId, messageIdHeader, fromEmail, subject }`. Plain text preferred; falls back to stripping HTML if only HTML is present.
- `sendReply({ threadId, to, subject, inReplyTo, references, body })` — builds an RFC 2822 message, base64url-encodes it, posts to `messages.send` with `threadId` so Gmail threads it correctly.
- `archiveMessage(id)` — `messages.modify` removing `INBOX` and `UNREAD` labels in one call.

New functions in `src/lib/microsoft-graph.ts`:

- `getMessageBody(id)` — `GET /me/messages/{id}?$select=id,subject,from,body,conversationId`, returns `{ text, conversationId, fromEmail, subject }`. Graph returns HTML body by default; we strip tags for display and for draft context.
- `replyToMessage(id, body)` — `POST /me/messages/{id}/reply` with `comment` param. Graph handles reply envelope construction.
- `archiveMessage(id)` — `POST /me/messages/{id}/move` to the Archive well-known folder, which also marks read (we explicitly set `isRead: true` via a prior PATCH to be safe).

### Hooks

New hooks in `src/lib/hooks.ts`:

- `useMailDetail(id, provider)` — fetches the body. Returns `{ body, loading, error, replyContext }` where `replyContext` carries the provider-specific fields (`threadId`, `messageIdHeader` for Gmail; `conversationId` for Graph) that `sendReply` needs. The `provider` tag comes from the normalized mail item, so dispatch is explicit — no id-format sniffing.
- `useSendReply()` — returns `{ send: (mailId, body, draft) => Promise<void>, sending, error }`. Dispatches to the right provider, then calls archive, then tells `useInboxWaiting` to drop the row.

`useMailItems` is extended to tag each normalized mail with `provider: 'google' | 'microsoft'`. This avoids id-sniffing and makes the detail/send dispatch explicit.

Optimistic update: `useInboxWaiting` gets a `dismiss(id)` method that removes the row from local state before the server confirms. If send fails, nothing is dismissed. If archive fails after a successful send, we still dismiss (the mail was sent; archive can reconcile on next refresh).

### Screen

`src/screens/InboxDetailScreen.tsx`:

- Top: compact header with back button, sender name, relative time
- Subject: one-line heading
- Body: scrollable plain text, "Henter…" while loading, error state with retry if fetch fails
- Divider
- Draft section: "Dit svar" label + multiline `TextInput` pre-filled with `aiDraft`
- Footer: `Send` (primary) + `Arkivér` (ghost) buttons, inline error row above on failure

### Auth + scopes

`src/lib/auth.ts`:

- `GOOGLE_SCOPES`: `gmail.readonly` → `gmail.modify` (superset; keeps read, adds send + archive + mark-read)
- `MICROSOFT_SCOPES`: add `Mail.ReadWrite` and `Mail.Send`

Existing users have tokens with the old scopes. First call to the new write endpoints will 403; `tryWithRefresh` catches this, triggers `silentRefresh` which requests the updated scope set, and retries. If silent refresh fails (likely, since the scope set changed), the fallback to full re-auth kicks in and the user sees a consent prompt once.

No changes to the refresh plumbing itself — it already handles the "token exists but scope mismatch" case as long as we classify the 403 as a `ProviderAuthError`, which the new functions do.

## Error Handling

- **Body fetch fails** — detail stays open, shows "Kunne ikke hente mailen" with a retry button. Draft editor still works (user can still send based on the subject alone).
- **Send fails** — inline banner in the detail view: "Kunne ikke sende — prøv igen." Draft preserved. Archive is not attempted.
- **Send succeeds, archive fails** — we treat this as success from the user's perspective. Log the archive failure in `__DEV__`. Next inbox refresh will either show the row again (caller can re-archive) or it will still appear in waiting until the backend catches up — acceptable because the reply was sent.
- **Scope missing (403)** — handled transparently by `tryWithRefresh`. User sees a re-consent prompt, then the action completes.
- **No Claude key** — draft is empty; user writes their own. No special handling needed.

## Testing

Manual verification, since there's no test harness in the repo:

- **Gmail happy path** — connect Google, open a real inbox mail, edit draft, send, confirm reply appears in Sent and original is archived.
- **Gmail threading** — verify the sent reply is threaded with the original (check Gmail web client).
- **Graph happy path** — same with a Microsoft account.
- **Scope upgrade** — start with the old `gmail.readonly` token in storage; attempt to send; confirm re-consent prompt appears and send completes.
- **Send failure** — temporarily point the send URL to a 500-returning endpoint; confirm error banner + draft preserved.
- **Optimistic UI** — after send, confirm row disappears from "waiting" immediately and the "cleared" count increments without waiting for a refetch.
- **No draft case** — open a mail that didn't get a Claude draft (e.g. from a no-reply address); confirm detail opens with an empty editor and send still works.

## File Changes

New:

- `src/screens/InboxDetailScreen.tsx`

Modified:

- `src/lib/auth.ts` — scope constants
- `src/lib/gmail.ts` — add `getMessageBody`, `sendReply`, `archiveMessage`
- `src/lib/microsoft-graph.ts` — add `getMessageBody`, `replyToMessage`, `archiveMessage`
- `src/lib/hooks.ts` — add `useMailDetail`, `useSendReply`; extend `useMailItems` to tag provider; add `dismiss` to `useInboxWaiting`
- `src/lib/types.ts` — add `MailProvider` tag, `MailDetail` and `ReplyContext` types
- `src/screens/InboxScreen.tsx` — accept `onOpenMail`, wire row `onPress`
- `App.tsx` — add `selectedMailId` state, render `InboxDetailScreen` overlay

## Open Questions

None — design is locked. Implementation plan can proceed.
