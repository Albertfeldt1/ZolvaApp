// Cleanup logic for dismissed proposals.
//
// A `mail.send_reply` proposal is preceded by a real draft created in the
// user's mailbox (at mail.draft_reply time); the proposal just points at it
// via draft_id. Approving sends that draft; dismissing it should DELETE it,
// otherwise "Spring over" silently leaves an orphan draft behind. Calendar
// proposals create nothing in propose mode, so they have nothing to clean up.

export interface DraftDeletion {
  provider: 'google' | 'microsoft';
  draftId: string;
}

export function draftDeletionForProposal(
  actionType: string,
  payload: Record<string, unknown>,
): DraftDeletion | null {
  if (actionType !== 'mail.send_reply') return null;
  const provider = payload.provider;
  const draftId = payload.draft_id;
  if (provider !== 'google' && provider !== 'microsoft') return null;
  if (typeof draftId !== 'string' || draftId === '') return null;
  return { provider, draftId };
}
