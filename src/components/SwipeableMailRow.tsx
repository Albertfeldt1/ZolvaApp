// src/components/SwipeableMailRow.tsx
//
// Horizontal-swipe wrapper for inbox mail rows. Swipe right → archive,
// swipe left → delete. Both surface a colored reveal under the row as
// the user drags; releasing past a threshold triggers the action and
// the row slides off-screen.
//
// Built on PanResponder + Animated (vanilla RN) instead of
// react-native-gesture-handler's Swipeable so this can ship via OTA
// without a native build. Slightly less smooth than gesture-handler at
// the gesture-claim boundary; acceptable for v1.
//
// "Delete" today is the same backend action as archive (markMailDismissed
// for Gmail/iCloud, graphDeleteMessage TBD for Outlook). The visual
// differentiation signals stronger intent; real server-side delete is
// follow-up work.

import { Trash2, Archive } from 'lucide-react-native';
import React, { useMemo, useRef } from 'react';
import { Animated, Dimensions, PanResponder, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/useTheme';

type Props = {
  onArchive: () => void;
  onDelete: () => void;
  children: React.ReactNode;
};

const SCREEN_WIDTH = Dimensions.get('window').width;
// Distance the row must travel before release commits the action. Tuned
// so a deliberate swipe commits but a hesitant flick springs back.
const COMMIT_THRESHOLD = 96;
// Velocity-based commit — fast flicks commit even if they don't reach
// the distance threshold. Matches iOS Mail's behavior.
const COMMIT_VELOCITY = 1.2;
const REVEAL_WIDTH = 96;

export function SwipeableMailRow({ onArchive, onDelete, children }: Props) {
  const { spacing, radius } = useTheme();
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only when horizontal motion clearly dominates.
        // Otherwise the parent ScrollView keeps vertical scroll.
        onMoveShouldSetPanResponder: (_, g) => {
          return Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
        },
        onPanResponderGrant: () => {
          translateX.stopAnimation();
        },
        onPanResponderMove: (_, g) => {
          translateX.setValue(g.dx);
        },
        onPanResponderRelease: (_, g) => {
          const commitRight = g.dx > COMMIT_THRESHOLD || g.vx > COMMIT_VELOCITY;
          const commitLeft = g.dx < -COMMIT_THRESHOLD || g.vx < -COMMIT_VELOCITY;
          if (commitRight) {
            Animated.timing(translateX, {
              toValue: SCREEN_WIDTH,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              onArchive();
            });
          } else if (commitLeft) {
            Animated.timing(translateX, {
              toValue: -SCREEN_WIDTH,
              duration: 220,
              useNativeDriver: true,
            }).start(() => {
              onDelete();
            });
          } else {
            Animated.spring(translateX, {
              toValue: 0,
              useNativeDriver: true,
              friction: 7,
              tension: 80,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            friction: 7,
            tension: 80,
          }).start();
        },
      }),
    [onArchive, onDelete, translateX],
  );

  // Reveal opacity ramps from 0 → 1 over the first ~half of the swipe so
  // the action color is fully visible by the time the user is committing.
  const archiveOpacity = translateX.interpolate({
    inputRange: [0, COMMIT_THRESHOLD * 0.6],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const deleteOpacity = translateX.interpolate({
    inputRange: [-COMMIT_THRESHOLD * 0.6, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ position: 'relative' }}>
      {/* Archive reveal (left side, swipe RIGHT exposes it). */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: '#3A8A4F',
            borderRadius: radius.cardSm,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-start',
            paddingLeft: spacing.lg,
            opacity: archiveOpacity,
          },
        ]}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            width: REVEAL_WIDTH,
          }}
        >
          <Archive size={18} color="#fff" strokeWidth={2} />
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Arkivér</Text>
        </View>
      </Animated.View>

      {/* Delete reveal (right side, swipe LEFT exposes it). */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: '#D14343',
            borderRadius: radius.cardSm,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingRight: spacing.lg,
            opacity: deleteOpacity,
          },
        ]}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            width: REVEAL_WIDTH,
            justifyContent: 'flex-end',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>Slet</Text>
          <Trash2 size={18} color="#fff" strokeWidth={2} />
        </View>
      </Animated.View>

      <Animated.View
        {...panResponder.panHandlers}
        style={{ transform: [{ translateX }] }}
      >
        {children}
      </Animated.View>
    </View>
  );
}
