// src/lib/mail-signature/build-outgoing-body.ts
//
// Provider-agnostic body+attachments builder. Outlook calls this from
// microsoft-graph.ts; iCloud SMTP will call it when that path is built.
// Returns the contentType, the assembled content (text or html), and the
// list of inline attachments to include in the outgoing message.

import { loadSignature } from './storage';
import { bodyToParagraphs, renderSignature } from './template';
import type { InlineAttachmentSpec } from './types';

export type OutgoingBody = {
  contentType: 'text' | 'html';
  content: string;
  attachments: InlineAttachmentSpec[];
};

export async function buildOutgoingBody(rawBody: string): Promise<OutgoingBody> {
  const data = await loadSignature();
  const rendered = data ? renderSignature(data) : null;

  if (!rendered) {
    return { contentType: 'text', content: rawBody, attachments: [] };
  }

  const bodyHtml = bodyToParagraphs(rawBody);
  const content = `${bodyHtml}${rendered.html}`;

  const attachments: InlineAttachmentSpec[] = rendered.image
    ? [{
        filename: rendered.image.mimeType === 'image/png' ? 'signature.png' : 'signature.jpg',
        mimeType: rendered.image.mimeType,
        contentBytes: rendered.image.bytes,
        contentId: rendered.image.contentId,
      }]
    : [];

  return { contentType: 'html', content, attachments };
}
