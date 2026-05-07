// src/lib/mail-signature/use-screenshot.ts
//
// "Brug screenshot direkte" - picks an image, compresses it, and wraps
// it as an ImportedSignature whose html is a single <img src="cid:zolva-sig">.
// No AI call. Trade-off: pixel-perfect fidelity vs. no text-selection /
// no per-element link binding. The user opts in.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import type { ImportedSignature, InlineImage } from './types';

const MAX_DIMENSION = 1024;
const MAX_BASE64_LEN = 300_000;

export type UseScreenshotResult =
  | { ok: true; data: ImportedSignature }
  | { ok: false; reason: 'permission-denied' | 'cancelled' | 'too-large' | 'parse-failed' };

export function buildImageOnlySignature(image: InlineImage, importedAt: number): ImportedSignature {
  // display:block + max-width keeps the screenshot from breaking the
  // layout in narrow Outlook panes; height:auto preserves aspect ratio.
  // alt="" because the image IS the signature - there's no separate
  // text version that would benefit from a redundant alt.
  const html =
    `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse">` +
    `<tr><td style="padding:0">` +
    `<img src="cid:zolva-sig" style="display:block;max-width:600px;width:100%;height:auto" alt="">` +
    `</td></tr></table>`;
  return {
    kind: 'imported',
    html,
    plaintext: '',
    image,
    importedAt,
    socials: [],
  };
}

export function useScreenshotResultMessage(result: Extract<UseScreenshotResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at bruge et screenshot.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'parse-failed':      return 'Kunne ikke læse billedet. Prøv et andet.';
  }
}

export async function pickAndUseScreenshot(): Promise<UseScreenshotResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'permission-denied' };

  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'] as ImagePicker.MediaType[],
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) {
    return { ok: false, reason: 'cancelled' };
  }

  const asset = picked.assets[0];
  const isPng = (asset.mimeType ?? '').toLowerCase() === 'image/png'
    || asset.uri.toLowerCase().endsWith('.png');

  try {
    const longSide = Math.max(asset.width ?? 0, asset.height ?? 0);
    const scale = longSide > MAX_DIMENSION ? MAX_DIMENSION / longSide : 1;
    const targetWidth = Math.round((asset.width ?? MAX_DIMENSION) * scale);
    const targetHeight = Math.round((asset.height ?? MAX_DIMENSION) * scale);

    const manipulated = await manipulateAsync(
      asset.uri,
      [{ resize: { width: targetWidth, height: targetHeight } }],
      {
        compress: isPng ? 1 : 0.85,
        format: isPng ? SaveFormat.PNG : SaveFormat.JPEG,
        base64: true,
      },
    );

    const base64 = manipulated.base64 ?? '';
    if (!base64) {
      try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}
      return { ok: false, reason: 'parse-failed' };
    }
    if (base64.length > MAX_BASE64_LEN) {
      try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}
      return { ok: false, reason: 'too-large' };
    }

    try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}

    const image: InlineImage = {
      base64,
      mimeType: isPng ? 'image/png' : 'image/jpeg',
      width: manipulated.width ?? targetWidth,
      height: manipulated.height ?? targetHeight,
    };
    return { ok: true, data: buildImageOnlySignature(image, Date.now()) };
  } catch {
    return { ok: false, reason: 'parse-failed' };
  }
}
