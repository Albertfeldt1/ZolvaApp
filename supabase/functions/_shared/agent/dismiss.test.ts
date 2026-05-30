import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { draftDeletionForProposal } from './dismiss.ts';

Deno.test('draftDeletionForProposal: gmail send_reply returns its draft', () => {
  assertEquals(
    draftDeletionForProposal('mail.send_reply', { provider: 'google', draft_id: 'd1' }),
    { provider: 'google', draftId: 'd1' },
  );
});

Deno.test('draftDeletionForProposal: outlook send_reply returns its draft', () => {
  assertEquals(
    draftDeletionForProposal('mail.send_reply', { provider: 'microsoft', draft_id: 'm9' }),
    { provider: 'microsoft', draftId: 'm9' },
  );
});

Deno.test('draftDeletionForProposal: calendar proposal has no draft to delete', () => {
  // cal.* proposals create nothing in propose mode, so there is nothing to clean up.
  assertEquals(
    draftDeletionForProposal('cal.create_event', { provider: 'google', title: 'Frokost' }),
    null,
  );
});

Deno.test('draftDeletionForProposal: send_reply without a draft_id returns null', () => {
  assertEquals(draftDeletionForProposal('mail.send_reply', { provider: 'google' }), null);
  assertEquals(draftDeletionForProposal('mail.send_reply', { provider: 'google', draft_id: '' }), null);
});

Deno.test('draftDeletionForProposal: send_reply with an unknown provider returns null', () => {
  assertEquals(draftDeletionForProposal('mail.send_reply', { provider: 'icloud', draft_id: 'x' }), null);
});
