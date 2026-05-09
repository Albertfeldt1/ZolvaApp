// src/components/SwipeableMailRow.tsx
//
// Trailing-swipe for inbox rows with two floating circular action
// buttons. Drag the row leftward to expose Archive (blue) and Delete
// (red) circles anchored to the right edge:
//   - Short drag past snap threshold → spring-open so the user can tap
//     either circle.
//   - Drag right (or short left release) → spring closed.
//   - Long drag past COMMIT_THRESHOLD → fire Delete and slide off.
//   - Tap a circle while open → fire that action and slide off.
//
// Built on PanResponder + Animated so it ships via OTA without a native
// build (no react-native-gesture-handler dependency).
//
// The wrapper itself is transparent — circles float against the screen
// background that's exposed when the row slides left. They live just
// outside the wrapper's right edge in the resting state and slide in
// alongside the row's translateX, so they're never visible bleeding
// through the row's translucent card. No full-bleed commit-color is
// drawn behind the row, by design: the floating aesthetic loses the
// Apple-Mail-style "rightmost action fills the row" affordance, so the
// only feedback for a past-commit drag is the row sliding off when
// released.

import { Trash2, Archive } from 'lucide-react-native';
import React, { useMemo, useRef } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  View,
} from 'react-native';

type Props = {
  onArchive: () => void;
  onDelete: () => void;
  children: React.ReactNode;
};

const SCREEN_WIDTH = Dimensions.get('window').width;
const CIRCLE_SIZE = 52;
const CIRCLE_GAP = 14;
const EDGE_PADDING = 14;
// Reveal area large enough to hold both circles + gap + padding on
// either side, so the open-state lays out cleanly without circles
// touching the row or screen edge.
const REVEAL_WIDTH = EDGE_PADDING * 2 + CIRCLE_SIZE * 2 + CIRCLE_GAP;
// Past this much leftward drag, releasing snaps to open instead of closing.
const SNAP_OPEN_THRESHOLD = CIRCLE_SIZE * 0.7;
// Past this much leftward drag, releasing fires Delete (the destructive
// default for the rightmost trailing action).
const COMMIT_THRESHOLD = SCREEN_WIDTH * 0.55;
// Fast-flick commit: a quick leftward flick fires Delete even if the
// drag hasn't reached COMMIT_THRESHOLD, as long as it crossed snap.
const COMMIT_VELOCITY = 1.4;

const ARCHIVE_BG = '#007AFF';
const DELETE_BG = '#FF3B30';

export function SwipeableMailRow({ onArchive, onDelete, children }: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  // Captures translateX at gesture start so dragging from an already-
  // open row continues from its current offset rather than snapping
  // back to 0.
  const startValue = useRef(0);
  const isOpenRef = useRef(false);

  const close = () => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      friction: 7,
      tension: 80,
    }).start();
    isOpenRef.current = false;
  };

  const openSnap = () => {
    Animated.spring(translateX, {
      toValue: -REVEAL_WIDTH,
      useNativeDriver: true,
      friction: 7,
      tension: 80,
    }).start();
    isOpenRef.current = true;
  };

  const slideOff = (after: () => void) => {
    Animated.timing(translateX, {
      toValue: -SCREEN_WIDTH,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      isOpenRef.current = false;
      after();
    });
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => {
          // Claim once the gesture is at all horizontal-dominant. Same
          // threshold as the previous version - tuned for beta testers
          // who rarely produce a clean straight horizontal drag.
          return Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.1;
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          translateX.stopAnimation((value: number) => {
            startValue.current = value;
          });
        },
        onPanResponderMove: (_, g) => {
          // Clamp at 0 so a right-drag from closed never moves the row;
          // from open state, a right-drag walks translateX back toward 0.
          const next = Math.min(0, startValue.current + g.dx);
          translateX.setValue(next);
        },
        onPanResponderRelease: (_, g) => {
          const finalDx = startValue.current + g.dx;
          const fastLeftFlick = g.vx < -COMMIT_VELOCITY;

          if (
            finalDx <= -COMMIT_THRESHOLD ||
            (fastLeftFlick && finalDx <= -SNAP_OPEN_THRESHOLD)
          ) {
            slideOff(onDelete);
          } else if (finalDx <= -SNAP_OPEN_THRESHOLD) {
            openSnap();
          } else {
            close();
          }
        },
        onPanResponderTerminate: () => {
          if (isOpenRef.current) openSnap();
          else close();
        },
      }),
    [onDelete],
  );

  return (
    <View style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Floating action circles. The container's resting position is
          just past the wrapper's right edge (right: -REVEAL_WIDTH), so
          it's hidden by overflow:hidden when closed - including from
          the row's own translucent backdrop. As the row slides left
          via translateX, the circles share the same animated value and
          slide into view from the right at a 1:1 ratio. */}
      <Animated.View
        style={{
          position: 'absolute',
          right: -REVEAL_WIDTH,
          top: 0,
          bottom: 0,
          width: REVEAL_WIDTH,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: CIRCLE_GAP,
          paddingHorizontal: EDGE_PADDING,
          transform: [{ translateX }],
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Arkivér"
          onPress={() => slideOff(onArchive)}
          style={({ pressed }) => ({
            width: CIRCLE_SIZE,
            height: CIRCLE_SIZE,
            borderRadius: CIRCLE_SIZE / 2,
            backgroundColor: ARCHIVE_BG,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.18,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 4,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Archive size={22} color="#fff" strokeWidth={2.2} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Slet"
          onPress={() => slideOff(onDelete)}
          style={({ pressed }) => ({
            width: CIRCLE_SIZE,
            height: CIRCLE_SIZE,
            borderRadius: CIRCLE_SIZE / 2,
            backgroundColor: DELETE_BG,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: '#000',
            shadowOpacity: 0.18,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 4 },
            elevation: 4,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Trash2 size={22} color="#fff" strokeWidth={2.2} />
        </Pressable>
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
