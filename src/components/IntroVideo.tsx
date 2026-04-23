import React, { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { FadeOut } from 'react-native-reanimated';
import { colors } from '../theme';

// Bundled intro clip played on cold start. Lives in assets/ so it ships
// with the binary — no network required.
const INTRO_SOURCE = require('../../assets/intro.mp4');

// Fraction of the device height the video occupies. Container width
// follows VIDEO_ASPECT so the video fills its container exactly — no
// letterbox bars around it, no color matching needed against the
// surrounding splash.
const INTRO_HEIGHT_FRACTION = 0.50;

// width / height of the mp4 in assets/intro.mp4. If you swap the
// video for a different shape, update this to match or you'll get
// letterbox bars back. 9/16 is portrait HD.
const VIDEO_ASPECT = 9 / 16;

type Props = {
  onEnd: () => void;
};

export function IntroVideo({ onEnd }: Props) {
  const { width: screenW, height: screenH } = useWindowDimensions();
  // Start from a height-based target, then fall back to width-based
  // sizing (maintaining aspect) if the video would overflow screen
  // width. Prevents the container from going off-aspect — off-aspect
  // + contentFit=contain re-introduces letterbox bars.
  const targetHeight = screenH * INTRO_HEIGHT_FRACTION;
  const targetWidth = targetHeight * VIDEO_ASPECT;
  const widthCap = screenW * 0.92;
  const videoWidth = Math.min(targetWidth, widthCap);
  const videoHeight = videoWidth / VIDEO_ASPECT;

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
            style={{ width: videoWidth, height: videoHeight }}
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
