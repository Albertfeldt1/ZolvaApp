// Maps a reverse-token `kind` to the OAuth provider whose token can apply it.
// agent-undo uses this to load the correct refresh token (it was Google-only
// before calendar writes added Outlook-reversible actions).
export function reverseTokenProvider(token: { kind: string }): 'google' | 'microsoft' {
  switch (token.kind) {
    case 'gmail.modify':
    case 'gmail.draft':
    case 'gcal.event_delete':
    case 'gcal.event_restore':
      return 'google';
    case 'graph.draft':
    case 'graph.move':
    case 'graph.flag':
    case 'graph.category':
    case 'graph.event_delete':
    case 'graph.event_restore':
      return 'microsoft';
    default:
      throw new Error(`reverseTokenProvider: unknown reverse_token kind ${token.kind}`);
  }
}
