# Audit brief — <FEATURE NAME>

> Paste this AFTER the contents of `CONTEXT.md`. Replace every
> `<placeholder>` before sending to the audit terminal.

## Feature

**Name:** <e.g. "Daily brief generation">

**One-line claim:** <what does this feature claim to do for the user?
e.g. "Every weekday at the user's chosen time, push a Danish-language
summary of today's mail + calendar.">

**Realistic user path to trace end-to-end:** <one concrete scenario.
e.g. "User onboards Sunday evening, picks 7:30 brief time, has Gmail
+ Google Calendar connected. App is killed overnight. At 7:30 Monday,
push fires. User taps push. Brief opens.">

## Scope

**In-scope files** (audit reads these closely):

- `<src/lib/...>`
- `<src/screens/...>`
- `<supabase/functions/.../index.ts>`
- `<add 3-8 files; keep tight>`

**Out-of-scope** (mention only if surprising):

- <e.g. "Brief delivery on Android — iOS only for v1.">

**Surfaces touched** (UI + edge fns + DB tables):

- UI: <screen + component names>
- Edge fns: <list>
- DB: <table names; remember most aren't in repo migrations>

## Audit lens

**Primary lens:** function (default — does it work?)

**Specific questions to answer:**

1. <e.g. "Can the brief be generated twice for the same day under
   normal conditions?">
2. <e.g. "What happens when ALL the user's connected providers fail
   their fetch — does the brief still try to ship, ship empty, or
   skip entirely?">
3. <e.g. "If the user kills the app while the brief is generating
   server-side, does the next foreground reconcile pick it up?">
4. <add 3-6 questions; concrete and testable>

**Known constraints to keep in mind:**

- <e.g. "Briefs run sequentially per user inside a 15-minute cron
  window — see the dedupe constraint added 2026-05-08.">
- <e.g. "Daily brief edge fn has its own brief-already-exists
  check — verify the unique constraint and the function's check
  agree on the date boundary (timezone).">

## What you're producing

A markdown file at `docs/audits/findings/<feature-slug>.md` with this
structure:

```markdown
# Audit: <feature name>

**Auditor:** <model + session id or human handle>
**Date:** <YYYY-MM-DD>
**Time spent:** <minutes>

## Summary

<3-5 sentences. What works, what doesn't, where the risk
concentrates.>

## Findings

### F1 — <one-line title> [BLOCKER|HIGH|MEDIUM|LOW|NIT]

**Where:** `path/to/file.ts:LINE`
**Repro:** <one-line input that triggers it>
**Behavior observed:** <what the code does>
**Behavior expected:** <what the user/spec expects>
**Suggested direction:** <one sentence — NOT an implementation>

### F2 — ... (repeat)

## Adjacent findings (out of scope, noted but not investigated)

- <bullets>

## Open questions

- <things you couldn't determine in the time-box>

## Verification done

- <list of files you actually read end-to-end (not just grepped)>
- <list of code paths you traced manually>
- <typecheck run? other commands run?>
```

## Anti-goals (reminder)

- Flag, don't fix. No code edits.
- No refactor suggestions, no UI polish, no dependency upgrades.
- Stay inside scope. If you find something juicy outside, log it
  under "Adjacent findings" and move on.
- If you can't reproduce a hypothesis from the code alone, say so
  under "Open questions" — don't speculate.

## Time-box

**Hard stop at 90 minutes.** A partial audit with a clear cutoff
beats a rushed one. If you stop early, populate "Open questions"
with what you would have looked at next.
