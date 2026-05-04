// src/lib/mail-signature/index.ts
//
// Public API for the rich mail signature module. Internal files import
// from each other directly; everywhere else imports from this barrel.

export type {
  SignatureData,
  StructuredSignature,
  ImportedSignature,
  InlineImage,
  RenderedSignature,
  InlineAttachmentSpec,
  SocialLink,
  SocialType,
  LinkTarget,
} from './types';
export { EMPTY_SIGNATURE } from './types';
export { loadSignature, saveSignature, subscribeSignature } from './storage';
export { renderSignature, renderImported } from './template';
export { buildOutgoingBody } from './build-outgoing-body';
export type { OutgoingBody } from './build-outgoing-body';
export { pickAndCompressLogo, pickResultMessage } from './image';
export type { PickResult } from './image';
export {
  pickAndImportSignature,
  importResultMessage,
} from './import-from-screenshot';
export type { ImportResult } from './import-from-screenshot';
export { sanitizeSignatureHtml } from './sanitize';
