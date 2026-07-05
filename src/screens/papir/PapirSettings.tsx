import React, { useState, type ComponentType, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ArrowLeftRight, Bell, ChevronRight, Globe, Lock, Moon, Trash2, User, Vibrate } from 'lucide-react-native';
import { PaperText, Toggle, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { setPapirEnabled } from '../../lib/papir-flag';
import { PushHeader } from './PushHeader';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function SRow({
  Icon,
  label,
  right,
  danger,
  divider,
}: {
  Icon: IconCmp;
  label: string;
  right?: ReactNode;
  danger?: boolean;
  divider: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 13,
        padding: 15,
        borderTopWidth: divider ? 1 : 0,
        borderTopColor: papirColor.line,
      }}
    >
      <Icon size={19} color={danger ? papirColor.red : papirColor.ink2} strokeWidth={1.7} />
      <PaperText role="bodyStrong" color={danger ? papirColor.red : papirColor.ink} style={{ flex: 1 }}>
        {label}
      </PaperText>
      {right}
    </View>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ marginHorizontal: papirSpace.screen }}>
      <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginTop: 22, marginBottom: 10, paddingLeft: 4 }}>
        {label}
      </PaperText>
      <View
        style={{
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.xl,
          overflow: 'hidden',
          backgroundColor: papirColor.card,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export function PapirSettings() {
  const [haptics, setHaptics] = useState(true);
  const [reminders, setReminders] = useState(true);
  const [dark, setDark] = useState(false);

  const chevron = <ChevronRight size={16} color={papirColor.ink4} strokeWidth={2} />;
  const value = (s: string) => (
    <PaperText role="small" color={papirColor.ink3}>
      {s}
    </PaperText>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Indstillinger" />

      <Group label="Konto">
        <SRow Icon={User} label="Profil" right={chevron} divider={false} />
      </Group>

      <Group label="Stemme & sprog">
        <SRow Icon={Globe} label="Sprog" right={value('Dansk')} divider={false} />
        <SRow Icon={Vibrate} label="Haptik" right={<Toggle value={haptics} onValueChange={setHaptics} />} divider />
      </Group>

      <Group label="Notifikationer">
        <SRow Icon={Bell} label="Påmindelser" right={<Toggle value={reminders} onValueChange={setReminders} />} divider={false} />
      </Group>

      <Group label="Udseende">
        <SRow Icon={Moon} label="Mørkt tema" right={<Toggle value={dark} onValueChange={setDark} />} divider={false} />
      </Group>

      <Group label="Privatliv">
        <SRow Icon={Lock} label="Privatliv & data" right={chevron} divider={false} />
        <SRow Icon={Trash2} label="Slet alle data" danger right={chevron} divider />
      </Group>

      {/* Dev: exit hatch back to the classic UI (the toggle lives in the
          classic Settings' dev cluster; without this Papir is a roach motel). */}
      {__DEV__ ? (
        <Group label="Udvikler">
          <Pressable onPress={() => void setPapirEnabled(false)} accessibilityRole="button" accessibilityLabel="Skift til klassisk UI">
            <SRow Icon={ArrowLeftRight} label="Skift til klassisk UI" right={chevron} divider={false} />
          </Pressable>
        </Group>
      ) : null}
    </ScrollView>
  );
}
