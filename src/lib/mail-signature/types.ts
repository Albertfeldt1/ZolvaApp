// src/lib/mail-signature/types.ts
//
// Data shapes for the rich mail signature feature. SignatureData is the
// form state persisted to AsyncStorage. RenderedSignature is what the
// pure renderSignature() returns — html + plaintext + optional inline
// image. InlineAttachmentSpec is the wire-format the provider-agnostic
// build-outgoing-body helper hands to send paths (Outlook today, iCloud
// SMTP later).

export type SignatureData = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
  website: string;
  customLines: string;          // multiline freeform; also receives migrated plaintext
  logo: InlineImage | null;
};

export type InlineImage = {
  base64: string;               // raw base64, no data URI prefix
  mimeType: 'image/png' | 'image/jpeg';
  width: number;                // pixels — used for the <img> attribute, not for further compression
  height: number;
};

export type RenderedSignature = {
  html: string;
  plaintext: string;
  image: { contentId: 'zolva-sig'; bytes: string; mimeType: 'image/png' | 'image/jpeg' } | null;
};

export type InlineAttachmentSpec = {
  filename: string;             // 'signature.png' | 'signature.jpg'
  mimeType: string;
  contentBytes: string;         // base64
  contentId: string;            // matches the cid: in the HTML
};

export const EMPTY_SIGNATURE: SignatureData = {
  name: '',
  title: '',
  company: '',
  phone: '',
  email: '',
  website: '',
  customLines: '',
  logo: null,
};
