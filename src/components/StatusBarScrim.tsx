import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

const HEIGHT = Platform.OS === 'ios' ? 54 : 40;

export function StatusBarScrim() {
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <BlurView intensity={30} tint="light" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[
          'rgba(246,241,232,0.82)',
          'rgba(246,241,232,0.55)',
          'rgba(246,241,232,0)',
        ]}
        locations={[0, 0.6, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEIGHT,
    zIndex: 50,
    overflow: 'hidden',
  },
});
