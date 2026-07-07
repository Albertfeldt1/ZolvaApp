// src/lib/mail-signature/preview-html.ts
//
// WebView preview helpers for imported signatures - shared between the
// classic Settings editor and the Papir signature editor. Pure string
// building, no React.

import { applyBoundTargets } from './apply-bound-targets';
import { renderSocials } from './template';
import type { SocialLink } from './types';

export function buildPreviewHtml(sig: {
  html: string;
  image: { base64: string; mimeType: 'image/png' | 'image/jpeg' } | null;
  socials: SocialLink[];
}): string {
  // Apply any bound targets to the imported html (mirror the buildOutgoingBody
  // path) so the preview reflects what recipients will actually see - the
  // socials with target set become inline anchors in the html, and the
  // remaining unbound socials get appended as a separate row.
  const applied = applyBoundTargets({ html: sig.html, socials: sig.socials });
  const socialsRow = renderSocials(applied.unbound);
  let combined = applied.html + socialsRow;

  // Resolve cid:zolva-sig to a data URL so the WebView preview renders the
  // cropped logo without an external load. The outgoing-mail path keeps cid:
  // as-is - this transformation is preview-only.
  if (sig.image) {
    const cidDataUrl = `data:${sig.image.mimeType};base64,${sig.image.base64}`;
    combined = combined.replaceAll('cid:zolva-sig', cidDataUrl);
  }

  // Render the signature at a fixed 600 px logical width so wide CTA buttons
  // don't reflow into a squished multi-line shape inside the narrow preview
  // pane. The WebView scales the 600 px page down to fit its actual width,
  // giving a true "thumbnail" of how the email looks at email-client width.
  // Viewport ~420 logical px keeps content at email-client proportions
  // (CTA buttons stay side-by-side without wrapping) while landing at
  // ~0.8× of the actual WebView width - content renders large and
  // close to its natural size. Body padding kept tight (4 px) so the
  // signature fills the preview pane edge-to-edge.
  return `<!doctype html><html><head><meta name="viewport" content="width=420,initial-scale=0.81,user-scalable=no"><style>html,body{margin:0;padding:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:transparent;}img{max-width:100%;height:auto;}</style></head><body>${combined}</body></html>`;
}

export function formatImportedDate(unixMs: number): string {
  if (!unixMs) return '';
  const d = new Date(unixMs);
  try {
    return new Intl.DateTimeFormat('da-DK', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
