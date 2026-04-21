# Zolva Privacy Policy

Effective date: 20 April 2026
Last updated: 20 April 2026

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
- OAuth tokens: when you connect Gmail/Google Calendar or Outlook, we
  store a refresh token in our database so we can fetch new emails on
  your behalf. Provider access tokens are stored locally on your device
  in encrypted app storage.
- Email metadata and email content: to generate summaries and drafts,
  we retrieve subject line, sender, recipients, and body text from the
  emails you interact with, or that arrive in your inbox after you
  enable "New mail" notifications.
- Calendar events: title, time, location, and attendees. Used for your
  daily overview and reminders.
- Push token: an anonymous token from Apple/Expo that lets us send
  notifications to your device.
- Push notification content: when you enable "New mail", we send push
  notifications that by default contain the email's sender (in the
  notification title) and subject line (in the body). This is also
  shown on your lock screen depending on your iOS notification
  settings. You can hide content by opening iOS Settings >
  Notifications > Zolva > Show Previews and selecting "When Unlocked"
  or "Never". You can also turn off "New mail" in Zolva.
- App settings: notification preferences, work preferences, and privacy
  toggles are stored locally and/or in our database linked to your
  user ID.
- Chat and reminder history: text you enter in Zolva (chat with the
  assistant, notes, reminders).

We do not collect advertising IDs, location, or contacts.

## 3. OAuth scopes and what they are used for

When you connect an account, we request the following permissions. You
can revoke them at any time in your Google or Microsoft account.

### Google

- openid, email, profile: to sign you in and display your name.
- gmail.modify: read and modify your emails (for example, mark as
  read, create drafts). We never delete emails without your action.
- calendar.readonly: read calendar events for your daily overview.

### Microsoft

- openid, email, profile, offline_access: sign-in and persistent access.
- Mail.ReadWrite, Mail.Send: read emails, create drafts, and send
  replies you explicitly approve.
- Calendars.Read: read calendar events.

## 4. Data processors and sub-processors

We use the following providers to operate the service:

- Supabase (eu-west-1, Ireland): hosted database, auth, and edge
  functions. All your account and user data is stored in the EU.
- Expo Application Services: push notifications and build
  infrastructure.
- Google LLC / Microsoft Corp.: OAuth and APIs for Gmail/Calendar and
  Outlook/Calendar respectively. Your data resides in these systems.
  We retrieve it via your tokens.
- Anthropic PBC (sub-processor): we send email subjects, senders,
  content from emails you explicitly ask Zolva to summarize or reply
  to, calendar titles, and your chat messages to Anthropic's Claude
  model to generate replies and summaries. Anthropic does not use this
  data to train models, per their business terms for API access.
  Anthropic may retain prompts for up to 30 days for abuse monitoring.
- Vercel Inc.: hosting of this privacy policy. No personal data from
  the app is sent to Vercel.

## 5. Why we process your data (legal basis)

- Performance of contract (Art. 6(1)(b)): to deliver Zolva's core
  features. Daily overview, mail assistant, calendar, reminders.
- Consent (Art. 6(1)(a)): when you enable specific optional features,
  for example "New mail" notifications, connecting Google/Microsoft,
  or push notifications. You can withdraw consent at any time in
  Settings.

## 6. Data storage and retention

- OAuth refresh tokens: retained for as long as you have the account
  connected. Deleted when you disconnect the account or delete your
  account.
- Email content sent to Claude: sent directly to Anthropic on demand
  and not retained permanently by Zolva. Anthropic may retain prompts
  for up to 30 days for abuse monitoring.
- Chat and reminder history: stored locally on your device and/or in
  our database linked to your user ID, until you delete them or delete
  your account.
- Push token: retained until you disable notifications or delete your
  account.
- Error logs without content: up to 30 days, then deleted.
- Account data upon deletion: deleted within 30 days of you deleting
  your account in the app. Backups are overwritten in a rolling cycle
  of up to 30 days.

## 7. Data location and transfer

Databases and edge functions run in the EU (Ireland, eu-west-1).
Transfers to Anthropic (USA) are based on Standard Contractual Clauses
(SCCs) per Commission Decision 2021/914. Google and Microsoft process
your data in accordance with their own policies and transfer
mechanisms, including the EU-U.S. Data Privacy Framework.

## 8. Security

All connections between the app and our backend use TLS. OAuth tokens
are stored in iOS Keychain or Android Keystore via encrypted app
storage. Database access is restricted via Row-Level Security, so
users can only access their own data.

## 9. Cookies and local storage

Zolva is a mobile app and does not use cookies. The app uses iOS
Keychain and Android Keystore to securely store OAuth tokens locally
on your device, and standard app storage for preferences and cache.

## 10. Your rights (GDPR)

You have the right to:

- Access: be informed of what data we hold about you.
- Rectification: have incorrect data corrected.
- Erasure ("right to be forgotten"): have your data deleted. Use
  "Delete account" in Settings. Deletion completes automatically
  within seconds and includes OAuth tokens, push tokens, mail
  watchers, and the user account itself.
- Data portability: receive a machine-readable copy of your data.
  Write to kontakt@zolva.io and we will provide a copy within 30 days.
- Restriction and objection: have processing restricted or object to
  it.
- Withdrawal of consent: where processing is based on consent, you
  can withdraw it. Withdrawal does not affect the lawfulness of
  processing that took place before the withdrawal.

Send your request to kontakt@zolva.io. We will respond within 30 days.

## 11. Right to complain

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

## 12. Account deletion

You can delete your account at any time:

1. Open Settings in Zolva.
2. Scroll to Account > Delete account.
3. Confirm by typing "SLET" and tap Delete account permanently.

Deletion includes: account information, OAuth refresh tokens, push
tokens, mail-watcher state, and all rows in our database linked to
your user ID. We also attempt to revoke your OAuth tokens at Google
and Microsoft. The action cannot be undone.

## 13. Children

Zolva is not directed at children under 13 (per the Danish Data
Protection Act § 6), and we do not knowingly collect data from
children. If you believe a child has provided us data, contact us and
we will delete it.

## 14. Changes to this policy

We update the policy when our data processing changes. Material
changes will be announced in the app. The last update date appears at
the top.

## 15. Contact

Questions? Write to kontakt@zolva.io.