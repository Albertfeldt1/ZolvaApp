import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { IconButton, PaperText, papirColor, papirSpace } from '../../design/papir';
import { usePapirNav } from './nav';

/** Back button + title for push screens. */
export function PushHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { back } = usePapirNav();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        paddingHorizontal: papirSpace.screen,
        paddingTop: 56,
        paddingBottom: 14,
      }}
    >
      <IconButton accessibilityLabel="Tilbage" onPress={back}>
        <ChevronLeft size={17} color={papirColor.ink} strokeWidth={2} />
      </IconButton>
      <PaperText role="heading" style={{ flex: 1 }}>
        {title}
      </PaperText>
      {right}
    </View>
  );
}
