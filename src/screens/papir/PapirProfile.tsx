import React, { type ComponentType } from 'react';
import { ScrollView, View } from 'react-native';
import {
  ChevronRight,
  Crown,
  Download,
  FileText,
  HelpCircle,
  Settings,
} from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirDarkSurface, papirRadius, papirSpace } from '../../design/papir';
import { usePapirNav, type PushScreen } from './nav';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const STATS: [string, string][] = [
  ['128', 'Optagelser'],
  ['64', 'Noter'],
  ['41', 'Opgaver'],
];

const MENU: { Icon: IconCmp; label: string; value?: string; screen?: PushScreen }[] = [
  { Icon: Settings, label: 'Indstillinger', screen: 'settings' },
  { Icon: Crown, label: 'Zolva Premium', value: 'Prøv gratis' },
  { Icon: FileText, label: 'Mine noter' },
  { Icon: Download, label: 'Eksportér data' },
  { Icon: HelpCircle, label: 'Hjælp & support' },
];

function MenuRow({ Icon, label, value, divider, onPress }: { Icon: IconCmp; label: string; value?: string; divider: boolean; onPress?: () => void }) {
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="none"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 16,
        borderTopWidth: divider ? 1 : 0,
        borderTopColor: papirColor.line,
      }}
    >
      <Icon size={20} color={papirColor.ink2} strokeWidth={1.7} />
      <PaperText role="body" style={{ flex: 1 }}>
        {label}
      </PaperText>
      {value ? (
        <PaperText role="small" color={papirColor.ink3}>
          {value}
        </PaperText>
      ) : (
        <ChevronRight size={17} color={papirColor.ink4} strokeWidth={2} />
      )}
    </ScaleButton>
  );
}

export function PapirProfile() {
  const nav = usePapirNav();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: 60, paddingBottom: 120 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Identity */}
      <View style={{ alignItems: 'center', paddingHorizontal: papirSpace.screen }}>
        <View
          style={{
            width: 78,
            height: 78,
            borderRadius: papirRadius.avatar,
            backgroundColor: papirColor.ink,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PaperText role="statNumber" color={papirColor.onInk} style={{ fontSize: 30 }}>
            OH
          </PaperText>
        </View>
        <PaperText role="name" style={{ marginTop: 16 }}>
          Oscar Hangaard
        </PaperText>
        <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 4 }}>
          oscar@zolva.io
        </PaperText>
      </View>

      {/* Stats */}
      <View
        style={{
          flexDirection: 'row',
          marginHorizontal: papirSpace.screen,
          marginTop: papirSpace.xl,
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.xxl,
          backgroundColor: papirColor.card,
        }}
      >
        {STATS.map(([n, l], i) => (
          <View
            key={l}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: 18,
              borderLeftWidth: i ? 1 : 0,
              borderLeftColor: papirColor.line,
            }}
          >
            <PaperText role="statNumber">{n}</PaperText>
            <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 4 }}>
              {l}
            </PaperText>
          </View>
        ))}
      </View>

      {/* Upsell */}
      <ScaleButton
        scaleTo={0.985}
        haptic="light"
        style={{
          marginHorizontal: papirSpace.screen,
          marginTop: papirSpace.lg,
          padding: 20,
          borderRadius: papirRadius.card,
          backgroundColor: papirDarkSurface.gradientFrom,
        }}
      >
        <PaperText role="titleSerif" color={papirColor.onInk} style={{ fontSize: 20, maxWidth: 210 }}>
          Lås hele assistenten op
        </PaperText>
        <PaperText role="caption" color={papirDarkSurface.muted} style={{ marginTop: 8 }}>
          Ubegrænsede optagelser, lokationspåmindelser og stemme-svar.
        </PaperText>
        <View
          style={{
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            marginTop: 16,
            backgroundColor: papirColor.paper,
            paddingVertical: 9,
            paddingHorizontal: 16,
            borderRadius: papirRadius.pill,
          }}
        >
          <PaperText role="small" color={papirColor.ink}>
            Se Premium
          </PaperText>
          <ChevronRight size={14} color={papirColor.ink} strokeWidth={2.4} />
        </View>
      </ScaleButton>

      {/* Menu */}
      <View
        style={{
          marginHorizontal: papirSpace.screen,
          marginTop: papirSpace.xl,
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.xxl,
          backgroundColor: papirColor.card,
          overflow: 'hidden',
        }}
      >
        {MENU.map((m, i) => (
          <MenuRow
            key={m.label}
            Icon={m.Icon}
            label={m.label}
            value={m.value}
            divider={i > 0}
            onPress={m.screen ? () => nav.push(m.screen as PushScreen) : undefined}
          />
        ))}
      </View>

      <View style={{ paddingHorizontal: papirSpace.screen, marginTop: papirSpace.xl }}>
        <Button label="Log ud" variant="ghost" />
      </View>
    </ScrollView>
  );
}
