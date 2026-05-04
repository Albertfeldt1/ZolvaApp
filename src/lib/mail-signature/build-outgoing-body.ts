// src/lib/mail-signature/build-outgoing-body.ts
//
// Provider-agnostic body+attachments builder. Branches on signature.kind:
// 'structured' goes through the existing template.ts pipeline, 'imported'
// uses the pre-sanitized html directly.

import { applyBoundTargets } from './apply-bound-targets';
import { loadSignature } from './storage';
import { bodyToParagraphs, renderImported, renderSignature, renderSocials } from './template';
import type { InlineAttachmentSpec, RenderedSignature, SocialLink } from './types';

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

  // data is guaranteed non-null here: rendered is only set when data is truthy.
  const sigData = data!;
  let signatureHtml: string;
  let socialsForRow: SocialLink[];
  if (sigData.kind === 'imported') {
    const applied = applyBoundTargets({ html: rendered.html, socials: sigData.socials });
    signatureHtml = applied.html;
    socialsForRow = applied.unbound;
  } else {
    // structured: target is ignored — socials always render as separate pills
    signatureHtml = rendered.html;
    socialsForRow = sigData.socials;
  }
  const fullSignatureHtml = signatureHtml + renderSocials(socialsForRow);

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
