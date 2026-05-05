import { BlurView } from 'expo-blur';
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useTheme } from '../useTheme';
import { Icon } from './Icon';
import { Stone } from './Stone';

export type TabId = 'today' | 'inbox' | 'cal' | 'mem';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  /** Bottom safe-area inset (home indicator). The bar sits 18pt above this. */
  bottomInset: number;
};

type IconRenderer = (props: { size?: number; color: string }) => React.ReactElement;

type Tab = { id: TabId; label: string; I: IconRenderer; color: string };

const FAB_STONE_SIZE = 22;
const FAB_TEXT_SIZE = 13;
const TAB_ICON_SIZE = 20;
const TAB_LABEL_SIZE = 10;

export function GlassTabBar({ active, onChange, onAskZolva, bottomInset }: Props) {
  const { t, fonts, surface, shadows, blur, spacing, radius } = useTheme();

  const TABS: Tab[] = [
    { id: 'today', label: 'I dag',    I: Icon.sun,      color: t.today },
    { id: 'inbox', label: 'Indbakke', I: Icon.mail,     color: t.inbox },
    { id: 'cal',   label: 'Kalender', I: Icon.cal,      color: t.cal   },
    { id: 'mem',   label: 'Husk',     I: Icon.bookmark, color: t.mem   },
  ];

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: bottomInset + spacing.tabBarLift,
        alignItems: 'center',
        gap: spacing.md - spacing.xs / 2, // 10pt
      }}
    >
      {/* Spørg Zolva FAB */}
      <View style={{ alignSelf: 'flex-end', marginRight: spacing.fabSideMargin }}>
        <Pressable
          onPress={onAskZolva}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            paddingVertical: 9,
            paddingLeft: 9,
            paddingRight: spacing.cardPad,
            borderRadius: radius.pill,
            backgroundColor: surface.fab,
            ...shadows.fab,
          }}
        >
          <Stone size={FAB_STONE_SIZE} jumpOnTap={false} />
          <Text
            style={{
              fontFamily: fonts.uiBold,
              fontSize: FAB_TEXT_SIZE,
              color: surface.fabText,
              letterSpacing: -0.1,
            }}
          >
            Spørg Zolva
          </Text>
        </Pressable>
      </View>

      {/* 4-tab pill */}
      <View style={{ alignSelf: 'stretch', marginHorizontal: spacing.tabBarSideMargin }}>
        <BlurView
          intensity={Platform.OS === 'ios' ? blur.tabBarIos : blur.tabBarAndroid}
          tint={t.mode === 'dark' ? 'dark' : 'light'}
          style={{
            borderRadius: radius.pill,
            overflow: 'hidden',
            ...shadows.tabBar,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              padding: spacing.sm,
              backgroundColor: surface.tabBar,
            }}
          >
            {TABS.map((tab) => {
              const isActive = active === tab.id;
              const Ic = tab.I;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => onChange(tab.id)}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: spacing.sm,
                    borderRadius: radius.pill,
                    backgroundColor: isActive ? surface.tabActive : 'transparent',
                  }}
                >
                  <Ic size={TAB_ICON_SIZE} color={isActive ? tab.color : t.ink3} />
                  <Text
                    style={{
                      fontFamily: fonts.uiBold,
                      fontSize: TAB_LABEL_SIZE,
                      color: isActive ? tab.color : t.ink3,
                      marginTop: 2,
                      letterSpacing: 0.1,
                    }}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </BlurView>
      </View>
    </View>
  );
}
