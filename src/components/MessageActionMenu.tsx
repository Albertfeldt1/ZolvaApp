import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Copy } from 'lucide-react-native';
import React from 'react';
import { Dimensions, Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '../design/useTheme';
import { renderInlineMd } from './inline-md';

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
// Rough safe margins (status bar / notch top, home indicator + dock bottom).
const SAFE_TOP = 64;
const SAFE_BOTTOM = 96;

function maxBubbleHeight(screenH: number): number {
  return Math.max(140, screenH - SAFE_TOP - SAFE_BOTTOM - MENU_HEIGHT - GAP * 2);
}

// iMessage-style long-press menu: dims the screen, lifts a copy of the pressed
// bubble, and floats a "Kopiér" action by it. Root-level Animated.View overlay
// (not a native <Modal>, which races other modals on iOS). The pressed bubble
// is re-rendered here from its measured window rect so it sits over the
// original (which the parent hides) while everything else dims.
//
// Long messages are capped to a max height (clipped, not scrolled — Kopiér
// still copies the full text) and the whole thing is repositioned to stay on
// screen so the bubble never overflows or collides with the menu.
export function MessageActionMenu({
  target,
  onCopy,
  onClose,
}: {
  target: MessageActionTarget | null;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t, type, fonts, surface, spacing, radius } = useTheme();
  const { width: screenW, height: screenH } = Dimensions.get('window');

  if (!target) return null;

  const { rect, isUser, text } = target;
  const clampedH = Math.min(rect.h, maxBubbleHeight(screenH));
  const isCapped = rect.h > maxBubbleHeight(screenH);
  const cardBg = isUser ? t.ink : surface.glass;

  // Keep the bubble in place when it fits with room for the menu below or
  // above; otherwise pin it under the top safe margin with the menu below.
  const fitsBelow =
    rect.y >= SAFE_TOP && rect.y + clampedH + GAP + MENU_HEIGHT <= screenH - SAFE_BOTTOM;
  const fitsAbove =
    rect.y + clampedH <= screenH - SAFE_BOTTOM && rect.y - GAP - MENU_HEIGHT >= SAFE_TOP;

  let bubbleTop: number;
  let menuTop: number;
  if (fitsBelow) {
    bubbleTop = rect.y;
    menuTop = rect.y + clampedH + GAP;
  } else if (fitsAbove) {
    bubbleTop = rect.y;
    menuTop = rect.y - GAP - MENU_HEIGHT;
  } else {
    bubbleTop = SAFE_TOP;
    menuTop = SAFE_TOP + clampedH + GAP;
  }

  const rawLeft = isUser ? rect.x + rect.w - MENU_WIDTH : rect.x;
  const menuLeft = Math.max(GAP, Math.min(rawLeft, screenW - MENU_WIDTH - GAP));

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 200 }}>
      {/* Blurred backdrop fades in; the original bubble is hidden by the
          parent while this is up, so only the lifted copy shows. The blur
          (plus a faint scrim for contrast) hides the busy chat behind. */}
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(120)}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <BlurView
          intensity={48}
          tint={t.mode === 'dark' ? 'dark' : 'light'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.18)' }}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Luk"
        />
      </Animated.View>

      {/* Lifted copy of the pressed bubble — appears in place, no scale/bounce,
          so there's no empty flash while the original is hidden. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: bubbleTop, left: rect.x, width: rect.w }}
      >
        <View
          style={{
            maxHeight: clampedH,
            overflow: 'hidden',
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
            borderRadius: 18,
            backgroundColor: cardBg,
            borderBottomRightRadius: isUser ? 6 : 18,
            borderBottomLeftRadius: isUser ? 18 : 6,
          }}
        >
          <Text style={{ ...type.body, color: isUser ? '#fff' : t.ink }}>
            {renderInlineMd(text, fonts.uiBold)}
          </Text>
          {/* Fade the clipped bottom of a long message so the cut reads as an
              intentional preview rather than a hard truncation. */}
          {isCapped && (
            <LinearGradient
              colors={['transparent', cardBg]}
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 }}
              pointerEvents="none"
            />
          )}
        </View>
      </View>

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
