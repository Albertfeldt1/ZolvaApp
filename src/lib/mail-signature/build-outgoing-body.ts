// src/lib/mail-signature/build-outgoing-body.ts
//
// Provider-agnostic body+attachments builder. Branches on signature.kind:
// 'structured' goes through the existing template.ts pipeline, 'imported'
// uses the pre-sanitized html directly.

import { loadSignature } from './storage';
import { bodyToParagraphs, renderImported, renderSignature, renderSocials } from './template';
import type { InlineAttachmentSpec, RenderedSignature } from './types';

export type OutgoingBody = {
  contentType: 'text' | 'html';
  content: string;
  attachments: InlineAttachmentSpec[];
};

export async function buildOutgoingBody(rawBody: string): Promise<OutgoingBody> {
  const data = await loadSignature();
  let rendered: RenderedSignature | null = null;
  if (data) {
    rendered = data.kind === 'imported' ? renderImported(data) : renderSignature(data);
  }

  if (!rendered) {
    return { contentType: 'text', content: rawBody, attachments: [] };
  }

  const socialsHtml = data ? renderSocials(data.socials) : '';
  const fullSignatureHtml = rendered.html + socialsHtml;

  const bodyHtml = bodyToParagraphs(rawBody);
  const content = `${bodyHtml}${fullSignatureHtml}`;

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
