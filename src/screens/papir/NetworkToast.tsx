// Global mikro-bekræftelse når netværks-ekstraktoren lander en person fra en
// gemt talenote. Ekstraktionen er fire-and-forget og debounced, så resultatet
// kommer først EFTER transskriptions-skærmen er lukket — uden denne toast er
// tilføjelsen usynlig. Chat-kilder springes over: PapirChat viser sin egen
// "Tilføjet til netværk"-linje under svaret. Samme pill-udtryk og placering
// som useUndoableDone-snackbaren; tryk åbner personkortet.
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { subscribeNetworkExtracted } from '../../lib/network-extractor';
import { usePapirNav } from './nav';

const SHOW_MS = 4_000;

export function NetworkToast() {
  const { user } = useAuth();
  const nav = usePapirNav();
  const [noted, setNoted] = useState<{ personId: string; name: string; isNew: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdRef = useRef<string | null>(user?.id ?? null);
  userIdRef.current = user?.id ?? null;

  useEffect(() => {
    const unsub = subscribeNetworkExtracted((e) => {
      if (e.source?.startsWith('chat:')) return;
      if (!userIdRef.current || e.userId !== userIdRef.current) return;
      setNoted({ personId: e.personId, name: e.name, isNew: e.isNew });
      Haptics.selectionAsync().catch(() => {});
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNoted(null), SHOW_MS);
    });
    return () => {
      unsub();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const insets = useSafeAreaInsets();
  if (!noted) return null;
  const navHeight = 68 + Math.max(insets.bottom, 16);
  return (
    <View
      pointerEvents="box-none"
      // Over push-lagene og transskriptionen (70/75), under recorderen (80).
      style={{ position: 'absolute', left: 0, right: 0, bottom: navHeight + 8, zIndex: 78, alignItems: 'center' }}
    >
      <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(140)}>
        <ScaleButton
          scaleTo={0.96}
          haptic="light"
          onPress={() => {
            if (timer.current) clearTimeout(timer.current);
            setNoted(null);
            nav.push('networkPerson', { personId: noted.personId });
          }}
          accessibilityRole="button"
          accessibilityLabel={`Åbn ${noted.name} i Netværk`}
          style={{
            backgroundColor: papirColor.ink,
            borderRadius: papirRadius.pill,
            paddingVertical: 10,
            paddingHorizontal: 18,
            marginHorizontal: papirSpace.screen,
          }}
        >
          <PaperText role="small" color={papirColor.onInk}>
            {noted.isNew ? 'Tilføjet til netværk: ' : 'Netværk opdateret: '}
            <PaperText role="small" color={papirColor.onInk} style={{ textDecorationLine: 'underline' }}>
              {noted.name}
            </PaperText>
          </PaperText>
        </ScaleButton>
      </Animated.View>
    </View>
  );
}
