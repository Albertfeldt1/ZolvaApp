import { Copy } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { Dimensions, Pressable, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useTheme } from '../design/useTheme';

export type BubbleRect = { x: number; y: number; w: number; h: number };
export type MessageActionTarget = {
  id: string;
  text: string;
  rect: BubbleRect;
  isUser: boolean;
};

const MENU_WIDTH = 168;
const MENU_HEIGHT = 46;
const GAP = 8;

// iMessage-style long-press menu: dims the screen, pops the pressed bubble up
// a touch, and floats a "Kopiér" action next to it. Rendered as a root-level
// Animated.View overlay (not a native <Modal>, which races other modals on
// iOS). The pressed bubble is re-rendered here from its measured window rect
// so it sits exactly over the original while everything else dims.
export function MessageActionMenu({
  target,
  onCopy,
  onClose,
}: {
  target: MessageActionTarget | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t, type, surface, spacing, radius } = useTheme();
  const scale = useSharedValue(0.97);

  useEffect(() => {
    if (target) {
      scale.value = 0.97;
      scale.value = withSpring(1.05, { damping: 15, stiffness: 230 });
    }
  }, [target, scale]);

  const bubbleAnim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  if (!target) return null;

  const { width: screenW, height: screenH } = Dimensions.get('window');
  const { rect, isUser, text } = target;

  // Place the menu above the bubble when it sits low on screen (most recent
  // messages do), otherwise below. Keep it on-screen horizontally.
  const menuAbove = rect.y > screenH * 0.45;
  const menuTop = menuAbove
    ? Math.max(GAP, rect.y - MENU_HEIGHT - GAP)
    : rect.y + rect.h + GAP;
  const rawLeft = isUser ? rect.x + rect.w - MENU_WIDTH : rect.x;
  const menuLeft = Math.max(GAP, Math.min(rawLeft, screenW - MENU_WIDTH - GAP));

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 }}>
      {/* Dim backdrop fades in; the original bubble is hidden by the parent
          while this is up, so only the lifted copy shows. */}
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(120)}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
      >
        <Pressable
          style={{ flex: 1 }}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Luk"
        />
      </Animated.View>

      {/* Enlarged copy of the pressed bubble, pinned over the original. Opaque
          immediately (only the scale springs) so there's no empty flash while
          the original is hidden. */}
      <Animated.View
        pointerEvents="none"
        style={[
          { position: 'absolute', top: rect.y, left: rect.x, width: rect.w },
          bubbleAnim,
        ]}
      >
        <View
          style={{
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
            borderRadius: 18,
            backgroundColor: isUser ? t.ink : surface.glass,
            borderBottomRightRadius: isUser ? 6 : 18,
            borderBottomLeftRadius: isUser ? 18 : 6,
          }}
        >
          <Text style={{ ...type.body, color: isUser ? '#fff' : t.ink }}>{text}</Text>
        </View>
      </Animated.View>

      {/* Action menu. */}
      <Animated.View
        entering={FadeIn.delay(60).duration(140)}
        style={{ position: 'absolute', top: menuTop, left: menuLeft, width: MENU_WIDTH }}
      >
        <View
          style={{
            backgroundColor: t.paper,
            borderRadius: radius.soft,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.18,
            shadowRadius: 12,
            elevation: 6,
          }}
        >
          <Pressable
            onPress={onCopy}
            accessibilityRole="button"
            accessibilityLabel="Kopiér"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              paddingVertical: spacing.sm + 2,
              paddingHorizontal: spacing.md,
              backgroundColor: pressed ? surface.glassWeak : 'transparent',
            })}
          >
            <Copy size={17} color={t.ink} strokeWidth={2.1} />
            <Text style={{ ...type.body, color: t.ink }}>Kopiér</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
