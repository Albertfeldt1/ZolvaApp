import React from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
  useFonts as useFraunces,
} from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts as useInter,
} from '@expo-google-fonts/inter';
import { PapirShell } from './PapirShell';

/**
 * Standalone root for previewing the Papir redesign in isolation. Loads only
 * the fonts Papir needs, then renders the shell. Wired in via a flag in
 * index.ts; flip that flag off to restore the real app. Touches nothing else.
 */
console.log('[PAPIR PREVIEW] root mounted');

export default function PapirPreviewRoot() {
  const [fraunces] = useFraunces({ Fraunces_400Regular, Fraunces_500Medium, Fraunces_600SemiBold });
  const [inter] = useInter({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  if (!fraunces || !inter) return null;
  return (
    <>
      <StatusBar style="dark" />
      <PapirShell />
    </>
  );
}
