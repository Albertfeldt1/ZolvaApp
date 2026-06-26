import React, { type ComponentType } from 'react';
import { Pressable, View } from 'react-native';
import { AudioLines, CalendarCheck, House, User } from 'lucide-react-native';
import { PaperText, RecordFAB, papirColor, papirSpace } from '../../design/papir';

export type PapirTab = 'home' | 'plan' | 'history' | 'profile';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ITEMS: { key: PapirTab; label: string; Icon: IconCmp }[] = [
  { key: 'home', label: 'I dag', Icon: House },
  { key: 'plan', label: 'Plan', Icon: CalendarCheck },
  { key: 'history', label: 'Historik', Icon: AudioLines },
  { key: 'profile', label: 'Profil', Icon: User },
];

function NavItem({
  label,
  Icon,
  active,
  onPress,
}: {
  label: string;
  Icon: IconCmp;
  active: boolean;
  onPress: () => void;
}) {
  const tint = active ? papirColor.ink : papirColor.ink4;
  return (
    <Pressable
      onPress={onPress}
      style={{ flex: 1, alignItems: 'center', gap: 4, paddingTop: 6 }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={23} color={tint} strokeWidth={1.7} />
      <PaperText role="navLabel" color={tint}>
        {label}
      </PaperText>
    </Pressable>
  );
}

type Props = {
  active: PapirTab;
  onChange: (t: PapirTab) => void;
  onRecord: () => void;
};

/** Bottom nav: I dag · Plan · [record FAB] · Historik · Profil. */
export function PapirBottomNav({ active, onChange, onRecord }: Props) {
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 92,
        paddingTop: 12,
        paddingHorizontal: 14,
        paddingBottom: 24,
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: papirColor.paper,
        borderTopWidth: 1,
        borderTopColor: papirColor.lineSoft,
      }}
    >
      <NavItem label={ITEMS[0].label} Icon={ITEMS[0].Icon} active={active === 'home'} onPress={() => onChange('home')} />
      <NavItem label={ITEMS[1].label} Icon={ITEMS[1].Icon} active={active === 'plan'} onPress={() => onChange('plan')} />
      <View style={{ width: 72, alignItems: 'center', marginTop: -14 }}>
        <RecordFAB onPress={onRecord} />
      </View>
      <NavItem label={ITEMS[2].label} Icon={ITEMS[2].Icon} active={active === 'history'} onPress={() => onChange('history')} />
      <NavItem label={ITEMS[3].label} Icon={ITEMS[3].Icon} active={active === 'profile'} onPress={() => onChange('profile')} />
    </View>
  );
}
