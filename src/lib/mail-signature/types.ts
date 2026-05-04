// src/lib/mail-signature/types.ts
//
// Data shapes for the rich mail signature feature.
//
// SignatureData is a discriminated union of two modes:
//   - 'structured' — name/title/company/etc. + optional logo (the original
//     rich-mail-signature feature). Renders via template.ts.
//   - 'imported'   — sanitized Outlook-safe HTML + plaintext + optional
//     cropped logo, produced by the screenshot-import flow. Renders by
//     using its `html` directly.
//
// The `kind` field tags each entry. Migration on read defaults legacy
// entries (no `kind` field) to 'structured' — see storage.ts.

export type SocialType =
  | 'linkedin' | 'twitter' | 'instagram' | 'facebook'
  | 'tiktok' | 'youtube' | 'github' | 'other';

export type SocialLink = {
  type: SocialType;
  url: string;
  label?: string;  // optional override, used when type === 'other' (else falls back to URL host).
};

export type StructuredSignature = {
  kind: 'structured';
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;
  logo: InlineImage | null;
  socials: SocialLink[];
};

export type ImportedSignature = {
  kind: 'imported';
  html: string;
  plaintext: string;
  image: InlineImage | null;
  importedAt: number;
  socials: SocialLink[];
};

export type SignatureData = StructuredSignature | ImportedSignature;

export type InlineImage = {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
};

export type RenderedSignature = {
  html: string;
  plaintext: string;
  image: { contentId: 'zolva-sig'; bytes: string; mimeType: 'image/png' | 'image/jpeg' } | null;
};

export type InlineAttachmentSpec = {
  filename: string;
  mimeType: string;
  contentBytes: string;
  contentId: string;
};

export const EMPTY_SIGNATURE: StructuredSignature = {
  kind: 'structured',
  name: '',
  title: '',
  company: '',
  phone: '',
  email: '',
  website: '',
  customLines: '',
  logo: null,
  socials: [],
};
