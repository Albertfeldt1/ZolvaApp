import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, PaperText, papirColor, papirSpace } from '../../design/papir';
import { usePapirNav } from './nav';

/** Back button + title for push screens.
 * Screens outside the push stack (e.g. transcription) pass an explicit
 * `onBack` — the default nav.back() only pops the stack. */
export function PushHeader({ title, right, onBack }: { title: string; right?: ReactNode; onBack?: () => void }) {
  const { back } = usePapirNav();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: papirSpace.screen,
        paddingTop: insets.top + 12,
        paddingBottom: 14,
      }}
    >
      <IconButton accessibilityLabel="Tilbage" onPress={onBack ?? back}>
        <ChevronLeft size={17} color={papirColor.ink} strokeWidth={2} />
      </IconButton>
      <PaperText role="heading" style={{ flex: 1 }}>
        {title}
      </PaperText>
      {right}
    </View>
  );
}
