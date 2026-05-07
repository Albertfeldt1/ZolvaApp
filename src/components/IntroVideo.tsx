import React, { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeOut } from 'react-native-reanimated';

// Bundled neon-Z ignite clip played on cold start. HEVC with a real alpha
// channel (re-encoded from the source mp4 via ffmpeg luma-key), so AVPlayer
// renders the black background as truly transparent - the gradient behind
// shows through, and the warm glow halo blends with smooth alpha falloff.
const INTRO_SOURCE = require('../../assets/intro.mov');

// Diagonal sweep matching the app icon: warm coral (top-left) → lavender
// purple (bottom-right). If you swap the icon palette, mirror it here so the
// intro reads as the icon "opening" into the app.
const GRADIENT_COLORS = ['#FF8868', '#E59BB8', '#B384E8'] as const;

type Props = {
  onEnd: () => void;
};

export function IntroVideo({ onEnd }: Props) {
  const player = useVideoPlayer(INTRO_SOURCE, (p) => {
    p.loop = false;
    p.muted = true;
    // Don't auto-play - we kick off play() below once the gradient has
    // painted, otherwise the Z can start igniting against a half-rendered
    // backdrop and the splash → intro handoff looks like a flash.
  });

  useEffect(() => {
    // Two RAFs ≈ one full paint cycle. By that point the LinearGradient
    // is on screen, so the user sees: native splash (gradient) → JS
    // gradient (continuous) → Z ignites. No flash, no premature animation.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        player.play();
      });
    });
    const sub = player.addListener('playToEnd', () => {
      onEnd();
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      sub.remove();
    };
  }, [player, onEnd]);

  return (
    <Animated.View exiting={FadeOut.duration(280)} style={styles.root} pointerEvents="auto">
      <LinearGradient
        colors={GRADIENT_COLORS}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Pressable style={styles.fill} onPress={onEnd}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
        />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FF8868',
    zIndex: 9999,
  },
  fill: {
    flex: 1,
  },
});
