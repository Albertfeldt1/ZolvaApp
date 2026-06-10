---
title: Privacy Policy
---

# Zolva Privacy Policy

Effective date: 20 April 2026
Last updated: 8 June 2026

Zolva ("we", "us", "the app") is a personal AI assistant that helps you
with your daily overview, calendar, and email. This policy explains
what information we process, why we process it, who we share it with,
and what rights you have.

## 1. Data controller

Oscar Hangaard
Vilkestrupvej 1
4623 Lille Skensved
Denmark
Contact: kontakt@zolva.io

## 2. What information we process

When you use Zolva, we process the following categories of personal
data:

- Account information: email address and an internal user ID with our
  backend provider (Supabase). If you sign in with Apple, we may
  receive a private relay address. If you sign in with Google or
  Microsoft, we may receive your name and profile picture from the
  provider.
- OAuth tokens: when you connect Gmail/Google Calendar or
  Outlook/Microsoft 365, we store a refresh token in our database so we
  can fetch new emails and calendar events on your behalf. Provider
  access tokens are stored locally on your device in encrypted app
  storage.
- iCloud credentials: if you connect Apple iCloud Mail/Calendar, you
  provide your Apple ID email and an Apple **app-specific password**
  (not your main Apple ID password). This credential is stored in
  encrypted storage on your device (iOS Keychain / Android Keystore)
  and on our backend so we can sync mail (IMAP) and calendar (CalDAV)
  on your behalf.
- Email metadata and email content: to generate summaries, triage your
  inbox, and draft replies, we retrieve subject line, sender,
  recipients, and body text from the emails in the mailboxes you
  connect. When you enable the assistant ("agent") or "New mail"
  notifications, new incoming mail is processed automatically as
  described in section 4.
- Calendar events: title, time, location, attendees, and description.
  Used for your daily overview, reminders, scheduling, and (with your
  approval) creating or updating events.
- Connected files: the two providers differ, and we describe them
  separately. Google Drive uses the per-file `drive.file` scope, so we
  can only access files you (or the app on your behalf) have opened or
  created with Zolva — not your whole Drive. Microsoft uses the
  `Files.Read` permission, which lets the assistant read — never edit or
  delete — files across your OneDrive/Microsoft 365 in order to find and
  reference documents for you.
- Subscription and purchase data: if you buy a Lite or Pro
  subscription, we process your subscription status via RevenueCat and
  the App Store / Google Play. We store your tier (free/lite/pro), the
  product identifier, the store, trial status, the current period end,
  a RevenueCat app-user identifier, and the raw subscription event. We
  do not receive or store your card or payment-card details.
- Push token: an anonymous token from Apple/Expo that lets us send
  notifications to your device.
- Push notification content: when you enable "New mail", we send push
  notifications that by default contain the email's sender (in the
  notification title) and subject line (in the body). The assistant may
  also send proactive notifications ("nudges"), for example reminders
  about commitments or upcoming meetings. Notification content is shown
  on your lock screen depending on your iOS notification settings. You
  can hide content by opening iOS Settings > Notifications > Zolva >
  Show Previews and selecting "When Unlocked" or "Never". You can also
  turn off "New mail" and the assistant in Zolva.
- App settings and assistant memory: notification preferences, work
  preferences, privacy toggles, and "facts" the assistant remembers
  about you (for example commitments and recurring tasks) are stored
  locally and/or in our database linked to your user ID. You can turn
  memory off and delete stored facts in Settings.
- Chat and reminder history: text you enter in Zolva (chat with the
  assistant, notes, reminders).

We do not collect advertising IDs, location, or contacts.

## 3. OAuth scopes and what they are used for

When you connect an account, we request the following permissions. You
can revoke them at any time in your Google, Microsoft, or Apple account.

### Google

- openid, email, profile: to sign you in and display your name.
- gmail.readonly: read your emails to summarise and triage them.
- gmail.compose: create draft replies. We do not request permission to
  modify or delete your emails, and Zolva never deletes your emails.
- calendar.events: read and (with your approval) create or update
  calendar events for your daily overview, reminders, and scheduling.
- calendar.calendarlist.readonly: read the list of your calendars so
  you can choose which one to use.
- drive.file: access only the specific Google Drive files you open or
  create with Zolva.

### Microsoft

- openid, email, profile, offline_access: sign-in and persistent
  access.
- Mail.ReadWrite, Mail.Send: read emails, create drafts, and send
  replies you approve.
- Calendars.ReadWrite: read and (with your approval) create or update
  calendar events.
- Files.Read: read-only access to your OneDrive/Microsoft 365 files so
  the assistant can find and reference documents. Unlike Google's
  per-file scope, this permission covers your files broadly; Zolva never
  modifies or deletes them.

### Apple iCloud (IMAP / CalDAV)

- Mail (IMAP, read-only): read your iCloud mail to summarise and triage
  it. Zolva does not send mail from iCloud accounts.
- Calendar (CalDAV, read/write): read and (with your approval) create
  or update iCloud calendar events.

## 4. Automated processing by the assistant

If you enable the assistant ("agent"), Zolva processes your connected
mailboxes and calendars automatically to help you keep up. Automatic
actions include: reading and summarising new mail, tracking commitments,
drafting reply suggestions, searching connected files, helping with
scheduling, and sending you notifications. The assistant does not
automatically move, label, archive, or delete your emails.

The following actions are **never** taken without your approval by
default: sending an email reply or a new email, responding to a meeting
invitation, and creating or updating a calendar event. For sending, you
may optionally choose to let the assistant send automatically to
**specific recipients you select** ("trust"); you can revoke this at any
time in Settings. You remain in control: you can disable the assistant,
limit what it may do, and review or undo its actions in the app. The
assistant does not make decisions that produce legal effects concerning
you (GDPR Art. 22).

## 5. Data processors and sub-processors

We use the following providers to operate the service:

- Supabase (eu-west-1, Ireland): hosted database, auth, and edge
  functions. All your account and user data is stored in the EU.
- Expo Application Services: push notifications and build
  infrastructure.
- Google LLC / Microsoft Corp. / Apple Inc.: mail and calendar APIs for
  Gmail/Calendar, Outlook/Calendar, and iCloud Mail/Calendar
  respectively. Your data resides in these systems; we retrieve it via
  your tokens or credentials.
- Anthropic PBC (sub-processor): to generate summaries, briefs, draft
  replies, and assistant actions, we send relevant email subjects,
  senders, recipients, and content, calendar titles and details,
  remembered facts, and your chat messages to Anthropic's Claude models.
  When the assistant is enabled, this includes new incoming mail
  processed automatically, not only items you open. Anthropic does not
  use this data to train its models, per their commercial terms for API
  access. Anthropic may retain prompts for up to 30 days for abuse
  monitoring.
- RevenueCat, Inc. (USA): manages your subscription status and entitlements.
  Receives a pseudonymous app-user identifier and subscription events
  from the App Store / Google Play. RevenueCat does not receive your
  email content, calendar, or card details.
- Apple App Store / Google Play: process subscription purchases and are
  your counterparty for the payment itself. We do not receive your
  payment-card details.
- GitHub, Inc. (GitHub Pages) / Vercel Inc.: hosting of this privacy
  policy and the zolva.io website. Like any web host they log standard
  visitor data (such as IP addresses) when you open these pages; no data
  from the app itself is sent to them.

## 6. Why we process your data (legal basis)

- Performance of contract (Art. 6(1)(b)): to deliver Zolva's core
  features — daily overview, mail assistant, calendar, reminders — and
  to provide and bill paid subscriptions.
- Consent (Art. 6(1)(a)): when you enable specific optional features,
  for example connecting Google/Microsoft/iCloud, enabling the
  assistant and automatic actions, "New mail" notifications, or push
  notifications. You can withdraw consent at any time in Settings.

## 7. Data storage and retention

- OAuth refresh tokens and iCloud credentials: retained for as long as
  you have the account connected. Deleted when you disconnect the
  account or delete your account.
- Email and calendar content sent to Claude: sent to Anthropic on
  demand and not retained permanently by Zolva. Anthropic may retain
  prompts for up to 30 days for abuse monitoring.
- Subscription data: retained while your account exists and as required
  for accounting/consumer-law obligations; deleted with your account
  subject to those obligations.
- Chat, reminder, and assistant-memory data: stored locally on your
  device and/or in our database linked to your user ID, until you
  delete them or delete your account.
- Push token: retained until you disable notifications or delete your
  account.
- Error logs without content: up to 30 days, then deleted.
- Account data upon deletion: deleted when you delete your account in
  the app (see section 12). Backups are overwritten in a rolling cycle
  of up to 30 days.

## 8. Data location and transfer

Databases and edge functions run in the EU (Ireland, eu-west-1).
Transfers to Anthropic (USA) and RevenueCat (USA) are based on Standard
Contractual Clauses (SCCs) per Commission Decision 2021/914. Google,
Microsoft, and Apple process your data in accordance with their own
policies and transfer mechanisms, including the EU-U.S. Data Privacy
Framework.

## 9. Security

All connections between the app and our backend use TLS. OAuth tokens
and iCloud credentials are stored in iOS Keychain or Android Keystore
via encrypted app storage on your device, and refresh tokens on the
backend are access-restricted. iCloud credentials stored on the backend
are additionally encrypted at rest, with the encryption key held
outside the database. Database access is governed by Row-Level
Security, so users can only access their own data.

## 10. Cookies and local storage

Zolva is a mobile app and does not use cookies. The app uses iOS
Keychain and Android Keystore to securely store OAuth tokens and iCloud
credentials locally on your device, and standard app storage for
preferences and cache.

## 11. Your rights (GDPR)

You have the right to:

- Access: be informed of what data we hold about you.
- Rectification: have incorrect data corrected.
- Erasure ("right to be forgotten"): have your data deleted. Use
  "Delete account" in Settings (see section 12).
- Data portability: receive a machine-readable copy of your data.
  Write to kontakt@zolva.io and we will provide a copy within 30 days.
- Restriction and objection: have processing restricted or object to
  it.
- Withdrawal of consent: where processing is based on consent, you
  can withdraw it. Withdrawal does not affect the lawfulness of
  processing that took place before the withdrawal.

Send your request to kontakt@zolva.io. We will respond within 30 days.

## 12. Account deletion

You can delete your account at any time:

1. Open Settings in Zolva.
2. Scroll to Account > Delete account.
3. Confirm by typing "SLET" and tap Delete account permanently.

Deletion runs immediately and removes: account information, OAuth
refresh tokens, push tokens, mail-watcher state, subscription/
entitlement records, and all rows in our database linked to your user
ID (including chat, mail, calendar, facts, and assistant data). We
attempt to revoke your Google OAuth token; Microsoft does not offer
per-token revocation, so any remaining Microsoft grant stays until it
expires or you revoke it in your Microsoft account. Connected iCloud
credentials are removed when you disconnect iCloud or delete your
account. The action cannot be undone.

## 13. Right to complain

You have the right to complain to the supervisory authority. In
Denmark this is:

Datatilsynet
Carl Jacobsens Vej 35
2500 Valby
Denmark
Phone: +45 33 19 32 00
Email: dt@datatilsynet.dk
Web: https://www.datatilsynet.dk

If you reside elsewhere in the EU, you may also contact your local
supervisory authority.

## 14. Children

Zolva is not directed at children under 13 (per the Danish Data
Protection Act § 6), and we do not knowingly collect data from
children. If you believe a child has provided us data, contact us and
we will delete it.

## 15. Changes to this policy

We update the policy when our data processing changes. Material
changes will be announced in the app. The last update date appears at
the top.

## 16. Contact

Questions? Write to kontakt@zolva.io.
