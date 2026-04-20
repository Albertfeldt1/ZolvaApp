# Zolva Privacy Policy

**Effective date:** 20 April 2026
**Last updated:** 20 April 2026

<!--
TODO for the data controller before publishing:
- Fill in contact email (search "TODO_CONTACT_EMAIL")
- Fill in legal entity / company registration (search "TODO_LEGAL_ENTITY")
- Confirm retention windows (search "TODO_CONFIRM")
-->

Zolva ("we", "us", "the app") is a personal AI assistant that helps you with
your daily overview, calendar and email. This policy explains what data we
process, why we process it, who we share it with and what rights you have.

## 1. Data controller

TODO_LEGAL_ENTITY
Contact: TODO_CONTACT_EMAIL

## 2. Data we process

When you use Zolva, we process the following categories of personal data:

- **Account information:** email address and an internal user ID from our
  backend provider (Supabase). If you sign in with Apple, we may receive
  a relay email. If you sign in with Google or Microsoft, we may receive
  your name and profile picture from the provider.
- **OAuth tokens:** when you connect Gmail/Google Calendar or Outlook, we
  store a refresh token in our database so we can fetch new mail on your
  behalf. Provider access tokens are stored locally on your device in
  encrypted app storage.
- **Mail metadata and mail content:** to generate summaries and drafts,
  we read subject, sender, recipients and body text of the emails you
  interact with or that land in your inbox after you have enabled the
  "New mail" notification.
- **Calendar events:** title, time, location and attendees — used for
  the daily overview and reminders.
- **Push token:** an anonymous token from Apple/Expo that lets us send
  notifications to your device.
- **Push notification content:** when you enable "New mail", our pushes
  include the mail's **sender** (in the notification title) and
  **subject** (in the body) by default. This is visible on your lock
  screen depending on your iOS notification settings. You can hide the
  content by opening **iOS Settings → Notifications → Zolva → Show
  Previews** and choosing "When Unlocked" or "Never". You can also turn
  "Nye mails" off in Zolva.
- **App settings:** notification preferences, work preferences and
  privacy toggles are stored locally and/or in our database tied to
  your user ID.
- **Chat and reminder history:** text you type into Zolva (chat with
  the assistant, notes, reminders).

We do **not** collect advertising IDs, location or contacts.

## 3. OAuth scopes and what they're used for

When you connect an account we request the following permissions. You can
revoke them at any time in your Google or Microsoft account settings.

### Google

- `openid`, `email`, `profile` — to sign you in and show your name.
- `gmail.modify` — read and modify your email (e.g. mark as read, create
  drafts). We never delete mail without your action.
- `calendar.readonly` — read calendar events for the daily overview.
- `drive.readonly` — read files you explicitly reference in Zolva.

### Microsoft

- `openid`, `email`, `profile`, `offline_access` — sign-in and persistent access.
- `Mail.ReadWrite`, `Mail.Send` — read mail, create drafts and send
  replies you explicitly approve.
- `Calendars.Read` — read calendar events.

## 4. Processors and sub-processors

We use the following providers (processors) to operate the service:

- **Supabase (TODO_CONFIRM_REGION — e.g. "eu-central-1, Frankfurt"):**
  hosted database, auth and edge functions. Confirm the actual region
  of your Supabase project (Dashboard → Project Settings → General)
  and update this text before publishing. If the region is outside
  the EU/EEA, transfers must be covered by Standard Contractual
  Clauses (SCCs) — see section 7.
- **Expo Application Services:** push notifications and build infrastructure.
- **Google LLC / Microsoft Corp.:** OAuth and APIs for Gmail/Calendar
  and Outlook/Calendar respectively. Your data lives in those systems —
  we fetch it using your tokens.
- **Anthropic PBC (sub-processor):** we send mail subjects, senders,
  mail content you open/ask to summarise, calendar titles and your
  chat messages to Anthropic's Claude model to generate responses and
  summaries. Anthropic **does not** use this data to train models under
  their API business terms.

## 5. Why we process your data (legal basis)

- **Performance of contract (Art. 6(1)(b)):** to deliver Zolva's core
  features — daily overview, mail assistant, calendar, reminders.
- **Consent (Art. 6(1)(a)):** when you enable specific optional
  features (e.g. "New mail" notifications, connecting Google/Microsoft,
  push notifications). You can withdraw consent at any time in Settings.
- **Legitimate interest (Art. 6(1)(f)):** for debugging and security,
  e.g. logging errors without the content of your messages.

## 6. Data storage and retention

- **OAuth refresh tokens:** kept while you have the account connected.
  Deleted when you disconnect the account or delete your Zolva account.
- **Mail content sent to Claude:** sent to Anthropic on demand and not
  stored long-term by Zolva. Anthropic may retain prompts for up to
  30 days for abuse monitoring (TODO_CONFIRM).
- **Chat and reminder history:** kept locally on your device and/or in
  our database tied to your user ID, until you delete them or delete
  your account.
- **Push token:** kept until you disable notifications or delete your
  account.
- **Logs without content:** up to 30 days (TODO_CONFIRM), then deleted.
- **Account data on deletion:** removed within 30 days of your request
  in-app. Backups roll over on a rotating cycle of up to 30 days
  (TODO_CONFIRM).

## 7. Data location and transfers

TODO_CONFIRM: Confirm the actual hosting region of your Supabase project
and adapt the paragraph below accordingly.

**If the database is in the EU/EEA (e.g. Frankfurt, Dublin, Stockholm):**
Databases and edge functions run in the EU/EEA. Transfers to Anthropic
(US) and to Google/Microsoft (global data centres) rely on Standard
Contractual Clauses (SCCs) under Commission Decision 2021/914 and,
for Google/Microsoft, the EU-U.S. Data Privacy Framework.

**If the database is outside the EU/EEA (e.g. us-east-1):**
Data is transferred to the US and covered by Standard Contractual
Clauses (SCCs) between us and Supabase as the transfer mechanism.
The same applies to Anthropic. Google and Microsoft process your
data under their own policies and applicable transfer mechanisms.

## 8. Your rights (GDPR)

You have the right to:

- **Access:** know what data we hold about you.
- **Rectification:** have incorrect data corrected.
- **Erasure ("right to be forgotten"):** have your data deleted. Use
  "Delete account" in Settings — deletion runs within seconds and
  covers OAuth tokens, push tokens, mail watchers and the account itself.
- **Data portability:** receive your data in a machine-readable format.
  Use "Export all data" in Settings.
- **Restriction and objection:** restrict or object to processing.
- **Withdraw consent:** where processing is based on consent, you can
  withdraw it without affecting the legality of past processing.

Send your request to TODO_CONTACT_EMAIL. We respond within 30 days.

## 9. Right to complain

You have the right to complain to the supervisory authority. In Denmark
that is:

**Datatilsynet (Danish Data Protection Agency)**
Carl Jacobsens Vej 35
2500 Valby, Denmark
Phone: +45 33 19 32 00
Email: dt@datatilsynet.dk
Web: https://www.datatilsynet.dk

## 10. Deleting your account

You can delete your account at any time:

1. Open **Settings** in Zolva.
2. Scroll to **Konto** → **Slet konto** (Account → Delete account).
3. Confirm by typing "SLET" and tapping **Slet konto permanent**.

Deletion covers: account information, OAuth refresh tokens, push tokens,
mail-watcher state and every row in our database tied to your user ID.
We also attempt to revoke your OAuth tokens at Google/Microsoft. The
action **cannot** be undone.

## 11. Children

Zolva is not directed at children under 13, and we do not knowingly
collect data about them. If you believe a child has given us data,
please contact us and we will delete it.

## 12. Changes to this policy

We update the policy when our data processing changes. Material changes
are announced in the app. The latest update date is shown at the top.

## 13. Contact

Questions? Write to TODO_CONTACT_EMAIL.
