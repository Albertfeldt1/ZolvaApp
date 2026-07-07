import React, { useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  ArrowLeftRight,
  Bell,
  BrainCircuit,
  ChevronRight,
  Cloud,
  Globe,
  Link2,
  Lock,
  Mail,
  PenLine,
  RefreshCw,
  Sun,
  Trash2,
  User,
} from 'lucide-react-native';
import { DeleteAccountScreen } from '../DeleteAccountScreen';
import { PaperText, Toggle, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { requestAppOverlay } from '../../lib/app-overlay-bridge';
import { useAuth } from '../../lib/auth';
import { clearCredential, loadCredential, type IcloudCredentialState } from '../../lib/icloud-credentials';
import { useIntegrationFlags } from '../../lib/integration-flags';
import { useConnections, useMemoryEnabled, usePrivacyToggles, useWorkPreferences } from '../../lib/hooks';
import { ensurePermission, syncOnAppForeground } from '../../lib/notifications';
import {
  getNotificationSettings,
  setNotificationSetting,
  subscribeNotificationSettings,
  type NotificationSettings,
} from '../../lib/notification-settings';
import { triggerBackfillRerun } from '../../lib/onboarding-backfill';
import { setPapirEnabled } from '../../lib/papir-flag';
import { registerPushToken, setMailWatchersEnabled, unregisterPushToken } from '../../lib/push';
import type { Connection } from '../../lib/types';
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

const STATUS_LABEL: Record<string, string> = {
  expired: 'Udløbet',
  stale: 'Genopretter…',
};

/** Forbundet: providers + per-integration toggles — parity with the classic
 * Settings' integrations section. Connected rows toggle the software flag
 * (grant stays); disconnected rows run OAuth (incl. admin-consent detection);
 * iCloud opens the shared App-level setup overlay via the bridge. Long-press
 * a provider row for the full log-out escape hatch. */
function ConnectionsGroup() {
  const { user } = useAuth();
  const connections = useConnections();
  const { flags } = useIntegrationFlags();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [icloudCred, setIcloudCred] = useState<IcloudCredentialState>({ kind: 'absent' });

  const reloadIcloud = useCallback(() => {
    if (!user?.id) {
      setIcloudCred({ kind: 'absent' });
      return;
    }
    void loadCredential(user.id).then(setIcloudCred).catch(() => {});
  }, [user?.id]);

  useEffect(() => {
    reloadIcloud();
  }, [reloadIcloud]);

  const icloudFlagOff = flags['icloud'] === false;
  const icloudStatus =
    icloudCred.kind === 'valid' && !icloudFlagOff ? 'connected'
    : icloudCred.kind === 'invalid' ? 'expired'
    : 'disconnected';

  const connect = async (c: Connection) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const r = await connections.connect(c.id);
      if (r.adminConsent) {
        // Work account whose tenant blocks user consent — hand over to the
        // shared admin-consent overlay with the tenant hint prefilled.
        requestAppOverlay({ kind: 'admin-consent', prefilledEmail: r.adminConsent.tenantHint });
        return;
      }
      if (r.error && !r.cancelled) {
        Alert.alert(c.title, 'Kunne ikke forbinde. Prøv igen.');
      }
      // cancelled → user closed the browser; stay silent.
    } catch {
      Alert.alert(c.title, 'Ingen forbindelse. Prøv igen.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDisconnect = (c: Connection) => {
    Alert.alert(
      `Log helt ud af ${c.title}?`,
      'Adgangen tilbagekaldes for alle tilhørende integrationer. Du kan forbinde igen når som helst.',
      [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Log ud',
          style: 'destructive',
          onPress: async () => {
            setBusyId(c.id);
            try {
              const r = await connections.disconnect(c.id);
              if (r.error) Alert.alert(c.title, 'Kunne ikke logge ud. Prøv igen.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  const confirmDisconnectIcloud = () => {
    if (!user?.id || icloudCred.kind === 'absent') return;
    const uid = user.id;
    Alert.alert('Log helt ud af iCloud?', 'Dit app-specifikke kodeord fjernes fra enheden.', [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Log ud',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearCredential(uid);
          } finally {
            reloadIcloud();
          }
        },
      },
    ]);
  };

  const rowRight = (c: Connection) => {
    if (busyId === c.id) return <ActivityIndicator size="small" color={papirColor.ink3} />;
    if (c.status === 'connected') {
      return <Toggle value onValueChange={() => void connections.setEnabled(c.id, false)} />;
    }
    if (c.status === 'disconnected' && flags[c.id] === false) {
      // Grant intact, integration switched off — flip back on locally.
      return <Toggle value={false} onValueChange={() => void connections.setEnabled(c.id, true)} />;
    }
    return (
      <PaperText role="small" color={c.status === 'stale' ? papirColor.ink3 : papirColor.red}>
        {STATUS_LABEL[c.status] ?? 'Forbind'}
      </PaperText>
    );
  };

  return (
    <Group label="Forbundet">
      {connections.data.map((c, i) => (
        <Pressable
          key={c.id}
          onPress={c.status === 'connected' ? undefined : () => void connect(c)}
          onLongPress={c.status === 'connected' || c.status === 'stale' ? () => confirmDisconnect(c) : undefined}
          accessibilityRole="button"
          accessibilityLabel={c.title}
          accessibilityHint={c.status === 'connected' ? 'Hold nede for at logge helt ud' : 'Tryk for at forbinde'}
        >
          <SRow Icon={Link2} label={c.title} right={rowRight(c)} divider={i > 0} />
        </Pressable>
      ))}
      <Pressable
        onPress={
          icloudStatus === 'connected'
            ? undefined
            : () =>
                requestAppOverlay({
                  kind: 'icloud-setup',
                  prefilledEmail: icloudCred.kind !== 'absent' ? icloudCred.credential.email : undefined,
                })
        }
        onLongPress={icloudCred.kind !== 'absent' ? confirmDisconnectIcloud : undefined}
        accessibilityRole="button"
        accessibilityLabel="iCloud"
        accessibilityHint={icloudStatus === 'connected' ? 'Hold nede for at logge helt ud' : 'Tryk for at forbinde'}
      >
        <SRow
          Icon={Cloud}
          label="iCloud"
          right={
            icloudStatus === 'connected' ? (
              <PaperText role="small" color={papirColor.ink3}>
                {icloudCred.kind !== 'absent' ? icloudCred.credential.email : 'Forbundet'}
              </PaperText>
            ) : (
              <PaperText role="small" color={papirColor.red}>
                {icloudStatus === 'expired' ? 'Kodeord afvist' : 'Forbind'}
              </PaperText>
            )
          }
          divider
        />
      </Pressable>
    </Group>
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
  const memoryEnabled = useMemoryEnabled();
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

      <ConnectionsGroup />

      <Group label="Mail">
        <Pressable onPress={() => nav.push('signature')} accessibilityRole="button" accessibilityLabel="Signatur">
          <SRow Icon={PenLine} label="Signatur" right={chevron} divider={false} />
        </Pressable>
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

      {/* Genscan: re-run the mail/calendar backfill so Zolva's memory catches
          up — reuses the shared onboarding-backfill overlay chain (K1). */}
      {user && memoryEnabled ? (
        <Group label="Hukommelse">
          <Pressable
            onPress={() =>
              Alert.alert('Genscan mails og kalender?', 'Zolva gennemgår dine kilder igen og finder nye fakta.', [
                { text: 'Annullér', style: 'cancel' },
                { text: 'Start genscan', onPress: () => triggerBackfillRerun() },
              ])
            }
            accessibilityRole="button"
            accessibilityLabel="Genscan"
          >
            <SRow Icon={RefreshCw} label="Genscan mails og kalender" right={chevron} divider={false} />
          </Pressable>
        </Group>
      ) : null}

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
