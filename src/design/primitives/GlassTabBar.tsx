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

export function GlassTabBar({ active, onChange, onAskZolva, bottomInset }: Props) {
  const { t, fonts } = useTheme();
  const dark = t.mode === 'dark';

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
        bottom: bottomInset + 18,
        alignItems: 'center',
        gap: 10,
      }}
    >
      {/* Spørg Zolva FAB */}
      <View style={{ alignSelf: 'flex-end', marginRight: 48 }}>
        <Pressable
          onPress={onAskZolva}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 9,
            paddingLeft: 9,
            paddingRight: 14,
            borderRadius: 9999,
            backgroundColor: dark ? 'rgba(242,239,232,0.92)' : 'rgba(21,23,26,0.78)',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.18,
            shadowRadius: 24,
            elevation: 8,
          }}
        >
          <Stone size={22} jumpOnTap={false} />
          <Text
            style={{
              fontFamily: fonts.uiBold,
              fontSize: 13,
              color: dark ? '#0E1117' : '#fff',
              letterSpacing: -0.1,
            }}
          >
            Spørg Zolva
          </Text>
        </Pressable>
      </View>

      {/* 4-tab pill */}
      <View style={{ alignSelf: 'stretch', marginHorizontal: 48 }}>
        <BlurView
          intensity={Platform.OS === 'ios' ? 70 : 60}
          tint={dark ? 'dark' : 'light'}
          style={{
            borderRadius: 9999,
            overflow: 'hidden',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.10,
            shadowRadius: 24,
            elevation: 6,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              padding: 8,
              backgroundColor: dark ? 'rgba(27,32,48,0.65)' : 'rgba(255,255,255,0.55)',
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
                    paddingVertical: 8,
                    borderRadius: 9999,
                    backgroundColor: isActive
                      ? dark
                        ? 'rgba(255,255,255,0.12)'
                        : 'rgba(255,255,255,0.9)'
                      : 'transparent',
                  }}
                >
                  <Ic size={20} color={isActive ? tab.color : t.ink3} />
                  <Text
                    style={{
                      fontFamily: fonts.uiBold,
                      fontSize: 10,
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
