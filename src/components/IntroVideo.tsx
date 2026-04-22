import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import Animated, { FadeOut } from 'react-native-reanimated';
import { colors } from '../theme';

// Bundled intro clip played on cold start. Lives in assets/ so it ships
// with the binary — no network required.
const INTRO_SOURCE = require('../../assets/intro.mp4');

type Props = {
  onEnd: () => void;
};

export function IntroVideo({ onEnd }: Props) {
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
      <Pressable style={StyleSheet.absoluteFill} onPress={onEnd}>
        <View style={StyleSheet.absoluteFill}>
          <VideoView
            player={player}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
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
    backgroundColor: colors.paper,
    zIndex: 9999,
  },
});
