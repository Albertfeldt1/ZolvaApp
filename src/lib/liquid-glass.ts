import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform } from 'react-native';

// isGlassEffectAPIAvailable guards iOS 26 beta builds that ship the
// component without the underlying API (expo issue #40911).
// isLiquidGlassAvailable checks component availability only - it does
// NOT check Reduce Transparency. UIKit's UIGlassEffectView degrades
// natively under Reduce Transparency to a translucent solid fill, the
// same way Apple's first-party apps do, so we let the OS handle that
// case instead of forcing the fallback.
export const liquidGlassReady =
  Platform.OS === 'ios' &&
  isGlassEffectAPIAvailable() &&
  isLiquidGlassAvailable();
