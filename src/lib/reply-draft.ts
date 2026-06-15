// Decides whether to seed the reply box with the AI-suggested draft.
//
// The seed must happen at most once per opened mail: after we've seeded,
// the user owns the text. If we kept re-seeding whenever the box was empty,
// the user could never discard the suggestion or archive with a blank box
// (the original bug — the seeding effect depended on the draft value).
export function shouldSeedReplyDraft(
  aiDraft: string | undefined | null,
  hasSeeded: boolean,
): boolean {
  return !!aiDraft && !hasSeeded;
}
