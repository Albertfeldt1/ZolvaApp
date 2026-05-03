import { Bell, Settings } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useUnreadNotificationCount } from '../lib/hooks';
import { colors } from '../theme';

type Props = {
  onOpenNotifications: () => void;
  onOpenSettings?: () => void;
};

export function TopRightActions({ onOpenNotifications, onOpenSettings }: Props) {
  const unread = useUnreadNotificationCount();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onOpenNotifications}
        style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Notifikationer"
      >
        <Bell size={16} color={colors.ink} strokeWidth={1.75} />
        {unread > 0 && <View style={styles.badge} />}
      </Pressable>
      {onOpenSettings && (
        <Pressable
          onPress={onOpenSettings}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Indstillinger"
        >
          <Settings size={16} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.clay,
    borderWidth: 1.5,
    borderColor: colors.paper,
  },
});
