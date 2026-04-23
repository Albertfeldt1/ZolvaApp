import React, { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { FadeOut } from 'react-native-reanimated';
import { colors } from '../theme';

// Bundled intro clip played on cold start. Lives in assets/ so it ships
// with the binary — no network required.
const INTRO_SOURCE = require('../../assets/intro.mp4');

// Fraction of the screen's shorter edge the video occupies. Keeps it
// centered as a small reveal element over the paper background instead
// of a full-screen takeover.
const INTRO_SIZE_FRACTION = 0.63;

type Props = {
  onEnd: () => void;
};

export function IntroVideo({ onEnd }: Props) {
  const { width, height } = useWindowDimensions();
  const size = Math.min(width, height) * INTRO_SIZE_FRACTION;

  const player = useVideoPlayer(INTRO_SOURCE, (p) => {
    p.loop = false;
    p.muted = true;
    p.play();
  });

  useEffect(() => {
    const sub = player.addListener('playToEnd', () => {
      onEnd();
    });
    return () => sub.remove();
  }, [player, onEnd]);

  return (
    <Animated.View exiting={FadeOut.duration(280)} style={styles.root} pointerEvents="auto">
      <Pressable style={styles.fill} onPress={onEnd}>
        <View style={styles.center}>
          <VideoView
            player={player}
            style={{ width: size, height: size }}
            contentFit="contain"
            nativeControls={false}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.intro,
    zIndex: 9999,
  },
  fill: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
