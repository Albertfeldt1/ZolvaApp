import {
  Button,
  GlassEffectContainer,
  Host,
  HStack,
  Image,
  Namespace,
  Spacer,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import {
  font,
  foregroundColor,
  frame,
  glassEffect,
  glassEffectId,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import React, { useId } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';
import { TABS, TabId } from './PhoneChrome';

type Props = {
  active: TabId;
  onChange: (id: TabId) => void;
  onAskZolva: () => void;
  showAsk?: boolean;
  darkBg?: boolean;
};

// Mapping from our TabId to SF Symbols. Lucide icons can't render natively
// inside SwiftUI's Host, so we use Apple's first-party symbol set on iOS 26.
const TAB_SYMBOLS: Record<Exclude<TabId, 'settings'>, SFSymbol> = {
  today: 'sun.max',
  inbox: 'envelope',
  calendar: 'calendar',
  memory: 'bookmark',
};

const ACTIVE_PILL_ID = 'liquid-tab-active-pill';
// Roomy upper bound so each tab grabs equal width inside the HStack
// (SwiftUI .frame(maxWidth: .infinity) idiom; we use a finite number
// because the JS bridge doesn't serialize Infinity).
const TAB_MAX_WIDTH = 9999;

const INK = '#1A1E1C';
const STONE = '#8C8578';
const PAPER = '#F6F1E8';

// darkBg is accepted for API-shape parity with ClassicTabBar but intentionally
// unused — SwiftUI's glass material adapts to system appearance natively.
export function LiquidTabBar({ active, onChange, onAskZolva, showAsk = true }: Props) {
  const namespaceId = useId();

  return (
    <View style={styles.wrap}>
      <Host matchContents={{ vertical: true }} style={styles.host}>
        <Namespace id={namespaceId}>
          <VStack spacing={12}>
            {showAsk && (
              <HStack>
                <Spacer />
                <Button
                  onPress={onAskZolva}
                  modifiers={[
                    padding({ leading: 14, trailing: 18, vertical: 10 }),
                    glassEffect({
                      glass: { variant: 'regular', interactive: true, tint: INK },
                      shape: 'capsule',
                    }),
                  ]}
                >
                  <HStack spacing={8}>
                    <Image systemName="bubble.left.fill" size={18} color={PAPER} />
                    <Text
                      modifiers={[
                        foregroundColor(PAPER),
                        font({ size: 13.5, weight: 'semibold' }),
                      ]}
                    >
                      Spørg Zolva
                    </Text>
                  </HStack>
                </Button>
              </HStack>
            )}

            <GlassEffectContainer spacing={20}>
              <HStack
                spacing={0}
                modifiers={[
                  padding({ vertical: 8 }),
                  glassEffect({
                    glass: { variant: 'regular' },
                    shape: 'roundedRectangle',
                    cornerRadius: 24,
                  }),
                ]}
              >
                {TABS.map((tab) => {
                  const isActive = active === tab.id;
                  const tint = isActive ? INK : STONE;
                  return (
                    <Button
                      key={tab.id}
                      onPress={() => onChange(tab.id)}
                      modifiers={[
                        frame({ maxWidth: TAB_MAX_WIDTH }),
                        padding({ vertical: 4, horizontal: 4 }),
                        // Active tab gets a glass pill with a matched ID so
                        // SwiftUI morphs the material from the old active tab
                        // to the new one when `active` changes.
                        ...(isActive
                          ? [
                              glassEffect({
                                glass: { variant: 'clear', tint: INK },
                                shape: 'capsule',
                              }),
                              glassEffectId(ACTIVE_PILL_ID, namespaceId),
                            ]
                          : []),
                      ]}
                    >
                      <VStack spacing={2}>
                        <Image systemName={TAB_SYMBOLS[tab.id as keyof typeof TAB_SYMBOLS]} size={20} color={tint} />
                        <Text
                          modifiers={[
                            foregroundColor(tint),
                            font({ size: 10, weight: 'semibold' }),
                          ]}
                        >
                          {tab.label}
                        </Text>
                      </VStack>
                    </Button>
                  );
                })}
              </HStack>
            </GlassEffectContainer>
          </VStack>
        </Namespace>
      </Host>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 20,
    marginBottom: Platform.OS === 'ios' ? 24 : 14,
  },
  host: {
    // Host fills available width; vertical size derived from SwiftUI content.
    width: '100%',
  },
});
