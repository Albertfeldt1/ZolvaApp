import React, { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ArrowLeftRight,
  Bell,
  BrainCircuit,
  ChevronRight,
  Globe,
  Lock,
  Mail,
  Sun,
  Trash2,
  User,
} from 'lucide-react-native';
import { DeleteAccountScreen } from '../DeleteAccountScreen';
import { PaperText, Toggle, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { usePrivacyToggles, useWorkPreferences } from '../../lib/hooks';
import { ensurePermission, syncOnAppForeground } from '../../lib/notifications';
import {
  getNotificationSettings,
  setNotificationSetting,
  subscribeNotificationSettings,
  type NotificationSettings,
} from '../../lib/notification-settings';
import { setPapirEnabled } from '../../lib/papir-flag';
import { registerPushToken, setMailWatchersEnabled, unregisterPushToken } from '../../lib/push';
import { usePapirNav } from './nav';
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

const NOTIF_ROWS: { key: keyof NotificationSettings; label: string; Icon: IconCmp }[] = [
  { key: 'reminders', label: 'Påmindelser', Icon: Bell },
  { key: 'digest', label: 'Dagligt overblik', Icon: Sun },
  { key: 'preAlerts', label: 'Møde-varsler', Icon: Bell },
  { key: 'newMail', label: 'Nye mails', Icon: Mail },
];

export function PapirSettings() {
  const nav = usePapirNav();
  const { user } = useAuth();
  const privacy = usePrivacyToggles();
  const workPrefs = useWorkPreferences();
  const [notif, setNotif] = useState<NotificationSettings>(() => getNotificationSettings());
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => subscribeNotificationSettings(setNotif), []);

  // Same permission/push/mail-watcher choreography as the classic Settings —
  // only the chrome differs.
  const toggleNotif = async (key: keyof NotificationSettings, next: boolean) => {
    if (next) {
      const result = await ensurePermission();
      if (result !== 'granted') {
        Alert.alert(
          'Tillad notifikationer',
          'Zolva kan ikke sende notifikationer før du giver tilladelse i systemindstillingerne.',
          [
            { text: 'Ikke nu', style: 'cancel' },
            { text: 'Åbn indstillinger', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
    }
    if (key === 'newMail') {
      if (next) {
        const registration = await registerPushToken();
        if (!registration.ok && registration.reason === 'no-session') {
          Alert.alert('Nye mails', 'Log ind før du aktiverer mail-notifikationer.');
          return;
        }
        if (!registration.ok && !__DEV__) {
          Alert.alert('Nye mails', 'Kunne ikke registrere enheden. Prøv igen om lidt.');
          return;
        }
        await setMailWatchersEnabled(true);
      } else {
        await unregisterPushToken();
        await setMailWatchersEnabled(false);
      }
    }
    await setNotificationSetting(key, next);
    void syncOnAppForeground();
  };

  // Work preferences cycle through their options on tap (picker sheet is
  // parity backlog — cycling covers the 2-4 option prefs the classic has).
  const cyclePref = async (id: (typeof workPrefs.data)[number]['id']) => {
    const pref = workPrefs.data.find((p) => p.id === id);
    if (!pref || pref.options.length === 0) return;
    const idx = pref.value ? pref.options.indexOf(pref.value) : -1;
    const next = pref.options[(idx + 1) % pref.options.length];
    // Surface failures — otherwise the optimistic value silently reverts on
    // next app start and the user's choice was never saved (M4).
    const result = await workPrefs.setValue(id, next);
    if (!result.ok) {
      Alert.alert('Indstillinger', 'Ændringen kunne ikke gemmes. Tjek din forbindelse og prøv igen.');
    }
  };

  // Enabling memory means Zolva reads mails/calendar to build a profile —
  // that needs an informed yes FIRST, not a silent toggle (H3/GDPR). The
  // other privacy toggles flip directly.
  const flipPrivacy = (id: string) => {
    const t = privacy.data.find((x) => x.id === id);
    if (id === 'memory-enabled' && t && !t.enabled) {
      Alert.alert(
        'Lad Zolva lære dig at kende',
        'Zolva bruger dine mails og din kalender til at huske fakta om dig (kontakter, aftaler, præferencer), så svar og briefinger bliver personlige. Du kan se og slette alt under Historik, og slå det fra igen når som helst.',
        [
          { text: 'Nej tak', style: 'cancel' },
          { text: 'Slå til', onPress: () => void privacy.flip(id) },
        ],
      );
      return;
    }
    void privacy.flip(id);
  };

  const chevron = <ChevronRight size={16} color={papirColor.ink4} strokeWidth={2} />;
  const value = (s: string) => (
    <PaperText role="small" color={papirColor.ink3}>
      {s}
    </PaperText>
  );

  return (
    <>
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Indstillinger" />

      <Group label="Konto">
        <Pressable onPress={() => nav.setTab('profile')} accessibilityRole="button" accessibilityLabel="Profil">
          <SRow Icon={User} label="Profil" right={value(user?.email ?? 'Ikke logget ind')} divider={false} />
        </Pressable>
        <SRow Icon={Globe} label="Sprog" right={value('Dansk')} divider />
      </Group>

      <Group label="Sådan arbejder jeg">
        {workPrefs.data.map((p, i) => (
          <Pressable key={p.id} onPress={() => void cyclePref(p.id)} accessibilityRole="button" accessibilityLabel={p.title}>
            <SRow Icon={BrainCircuit} label={p.title} right={value(p.value ?? '—')} divider={i > 0} />
          </Pressable>
        ))}
      </Group>

      <Group label="Notifikationer">
        {NOTIF_ROWS.map((r, i) => (
          <SRow
            key={r.key}
            Icon={r.Icon}
            label={r.label}
            right={<Toggle value={notif[r.key]} onValueChange={(v) => void toggleNotif(r.key, v)} />}
            divider={i > 0}
          />
        ))}
      </Group>

      <Group label="Privatliv">
        {privacy.data.map((t, i) => (
          <SRow
            key={t.id}
            Icon={Lock}
            label={t.label}
            right={<Toggle value={t.enabled} onValueChange={() => flipPrivacy(t.id)} />}
            divider={i > 0}
          />
        ))}
      </Group>

      {/* Account deletion must be reachable in-app (Apple 5.1.1(v) + GDPR) —
          reuses the classic confirm-flow screen (K2). */}
      {user ? (
        <Group label="Fare-zone">
          <Pressable onPress={() => setDeleteOpen(true)} accessibilityRole="button" accessibilityLabel="Slet konto">
            <SRow Icon={Trash2} label="Slet konto" danger right={chevron} divider={false} />
          </Pressable>
        </Group>
      ) : null}

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
    {deleteOpen ? (
      <View style={[StyleSheet.absoluteFill, { zIndex: 90, backgroundColor: papirColor.paper }]}>
        <DeleteAccountScreen onClose={() => setDeleteOpen(false)} onDeleted={() => setDeleteOpen(false)} />
      </View>
    ) : null}
    </>
  );
}
