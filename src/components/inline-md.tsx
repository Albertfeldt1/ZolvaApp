import React from 'react';
import { Text } from 'react-native';

// Minimal inline markdown: renders **bold** spans, leaves the rest as plain
// text. Shared by the chat Bubble and the long-press action menu so the
// lifted copy of a message matches the original exactly.
export function renderInlineMd(text: string, boldFamily: string): React.ReactNode[] {
  const parts = text.split(/\*\*([\s\S]+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={{ fontFamily: boldFamily }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}
