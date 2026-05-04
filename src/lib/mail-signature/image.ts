// src/lib/mail-signature/image.ts
//
// Image picker + compression for signature logos. Picks via
// expo-image-picker, compresses via expo-image-manipulator (max 400px on
// the long side), preserves PNG transparency, falls back to JPEG @ 0.8
// for everything else. Hard cap at ~150KB final base64.

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system';
import type { InlineImage } from './types';

export type PickResult =
  | { ok: true; image: InlineImage }
  | { ok: false; reason: 'permission-denied' | 'cancelled' | 'too-large' | 'failed' };

const MAX_DIMENSION = 400;
const MAX_BASE64_LEN = 150_000;

export async function pickAndCompressLogo(): Promise<PickResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, reason: 'permission-denied' };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: false,
    quality: 1,
  });
  if (result.canceled || !result.assets || result.assets.length === 0) {
    return { ok: false, reason: 'cancelled' };
  }

  const asset = result.assets[0];
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
        compress: isPng ? 1 : 0.8,
        format: isPng ? SaveFormat.PNG : SaveFormat.JPEG,
        base64: true,
      },
    );

    const base64 = manipulated.base64 ?? '';
    if (!base64) return { ok: false, reason: 'failed' };
    if (base64.length > MAX_BASE64_LEN) return { ok: false, reason: 'too-large' };

    // Best-effort cleanup of the manipulator's tmp file. Failures are silent.
    try { await FileSystem.deleteAsync(manipulated.uri, { idempotent: true }); } catch {}

    return {
      ok: true,
      image: {
        base64,
        mimeType: isPng ? 'image/png' : 'image/jpeg',
        width: manipulated.width,
        height: manipulated.height,
      },
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export function pickResultMessage(result: Extract<PickResult, { ok: false }>): string {
  switch (result.reason) {
    case 'permission-denied': return 'Giv adgang til billeder i Indstillinger for at tilføje et logo.';
    case 'cancelled':         return '';
    case 'too-large':         return 'Billedet er for stort, vælg en mindre fil.';
    case 'failed':            return 'Kunne ikke læse billedet. Prøv et andet.';
  }
}
