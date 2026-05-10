# Commit message convention — Zolva

> Paste at the end of any fix terminal session, after the fix is
> verified and ready to commit. Generic — does not reference
> specific files, scopes, or fix subjects.

## Format

Conventional Commits, single subject line, optional body.

```
<type>(<scope>): <imperative present-tense summary>

<optional body — bullet list of what changed and why>
```

Subject line ≤72 characters. Body lines ≤72 characters. Imperative
mood ("add", "fix", "remove" — not "added", "adds", "adding").

## Type

Pick exactly one:

- **`fix`** — corrects broken behavior. Most fix-terminal commits.
- **`feat`** — adds new user-visible functionality. Rare for fixes;
  if you reach for `feat`, double-check you're not actually doing
  a fix.
- **`docs`** — only changes files under `docs/` or comments. No
  code behavior change.
- **`refactor`** — restructures code without changing behavior.
  Almost never appropriate from a fix terminal — fix prompts
  forbid refactoring.
- **`chore`** — config, tooling, dependency, build. Rare.
- **`revert`** — reverts a prior commit. Use the SHA in the body.

If the commit reverts work AND adds new files (e.g. revert + file a
finding doc), the type is `docs` if the net deliverable is the
documentation, NOT `revert`. The git history will show the revert
clearly enough.

## Scope

Pick the narrowest scope that accurately describes the surface
touched. Use existing scopes from `git log --oneline -50` before
inventing one.

Common scopes seen in this repo:

- `chat` — chat orchestrator, chat-run, chat-finalize, chat tools
- `memory` — facts, notes, reminders, memory_enabled gate
- `mail` — Gmail / Outlook / iCloud mail surfaces, poll-mail
- `calendar` — Google / Microsoft / iCloud calendar surfaces
- `inbox` — InboxScreen UI and behaviors
- `widget` — iOS home-screen widget
- `voice` — Siri AppShortcuts and AppIntents
- `auth` — sign-in flow, identity linking, session
- `oauth` — provider OAuth, scopes, token refresh
- `briefs` / `daily-brief` — daily brief generation and delivery
- `db` — schema, migrations, constraints
- `audits` — anything under `docs/audits/`
- `fixes` — anything under `docs/fixes/` (e.g. FIX-CONTEXT.md)

If your change cuts across two scopes equally, pick the one
closest to the user impact. If three or more, drop the scope:
`fix: <summary>`. Don't comma-separate scopes.

## Subject line

- Imperative present tense
- No trailing period
- No "this commit" / "I'm" / "we"
- Lowercase after the colon (matches existing repo style)
- ≤72 characters including type and scope

Bad: `fix(memory): Updated the memory toggle to fix cross-device issue.`
Good: `fix(memory): converge memory_enabled across devices`

## Body (optional)

Include a body when:

- Multiple files / functions changed and the names aren't obvious
  from the subject
- The fix has a non-obvious reason a future reader needs to know
- The commit defers, reverts, or partially addresses something
  (so future-you searching `git log` finds the context)

Skip the body when:

- It's a one-line, one-file fix and the subject is enough
- The body would just restate the subject

Body format: terse bullets, one per logical change. No prose
paragraphs. No "what" without "where" — anchor each bullet to a
file or subsystem when not obvious.

```
fix(<scope>): <subject>

- <change 1, with file or subsystem named>
- <change 2>
- <constraint or non-obvious reasoning, if any>
```

## What NOT to put in commits

- "Co-authored-by: Claude" or any AI attribution. Solo project,
  no need.
- Issue / ticket references unless the repo actually uses them.
- "Tested by:" / "Reviewed by:" lines.
- Emoji prefixes, even if you've seen them in some repos.
- Long prose explanations. If it needs prose, it goes in
  `docs/`, not the commit message.

## What to do before committing

1. `git status` — verify only the files you intend are staged. If
   anything else is staged, unstage it. Mixed-scope commits make
   reverts painful.
2. `git diff --cached` — read your own diff. Catch leftover
   debug logs, accidentally-included files, stale comments.
3. `npx tsc --noEmit` — must pass. The pre-existing error in
   CONTEXT.md is the only acceptable failure.
4. Confirm the commit's diff is fully described by your subject
   + body. If you find yourself writing "and also...", split into
   two commits.

## Splitting commits

If the work touches multiple scopes, ship multiple commits, not
one big one. The test: could you revert one of these without
breaking the others? If yes, separate commits.

If a code fix and a docs file go together (the docs file describes
the fix), one commit is fine — they're the same deliverable.

If a revert + a new docs file go together (revert because of what
the docs file documents), one commit is fine — same deliverable
shape.

## What to do after committing

1. `git log --oneline -5` — confirm the commit looks right at a
   glance.
2. Do NOT push from the fix terminal. The human handles pushes —
   they may want to amend, squash, or reorder before pushing.
3. Tell the human in your output: the commit message, and that
   it's local-only awaiting their push.

## Stop conditions

- `git status` shows files you didn't expect — STOP and report.
- `git diff --cached` shows changes you didn't make — STOP and
  report.
- Typecheck fails with a NEW error — STOP. Do not commit a broken
  build.
- Multiple scopes touched and you can't cleanly split — STOP and
  ask the human how to bundle.

Don't run:

- `git push` (or `git push --force`)
- `git commit --amend` on a pushed commit (hash check first)
- `git rebase` of any kind
- `git reset --hard`
