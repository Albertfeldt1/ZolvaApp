import React from 'react';
import { Pressable, Text, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

interface Props {
  onPress: () => void;
  bottomOffset?: number;
  /** Reports the bar's measured height so callers can pad content to clear it. */
  onLayout?: (e: LayoutChangeEvent) => void;
}

/**
 * Persistent logged-out call-to-action. Rendered by App.tsx only while
 * `loggedOut`, sitting just above the tab chrome. Tapping opens the AuthSheet.
 */
export function LoginCtaBar({ onPress, bottomOffset = 0, onLayout }: Props) {
  return (
    <View style={[styles.wrap, { bottom: bottomOffset }]} pointerEvents="box-none" onLayout={onLayout}>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      >
        <Text style={styles.label}>Log ind for at komme i gang</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    alignItems: 'stretch',
  },
  button: {
    backgroundColor: '#1C1C1A',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  pressed: { opacity: 0.85 },
  label: { color: '#FBFBFA', fontSize: 16, fontWeight: '600' },
});
