import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Shared safe-area-derived paddings for Papir tab screens (H36).
 * top clears the status bar / Dynamic Island; bottom clears the bottom nav
 * (68pt content + home-indicator inset — keep in sync with PapirBottomNav). */
export function usePapirScreenPads(): { top: number; bottom: number } {
  const insets = useSafeAreaInsets();
  return {
    top: insets.top + 8,
    bottom: 68 + Math.max(insets.bottom, 16) + 24,
  };
}
