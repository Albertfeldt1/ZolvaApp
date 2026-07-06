import React, { useMemo, type ComponentType } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { usePapirScreenPads } from './insets';
import {
  Bot,
  ChevronRight,
  Crown,
  Download,
  FileText,
  HelpCircle,
  RotateCcw,
  Settings,
} from 'lucide-react-native';
import Purchases from 'react-native-purchases';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirDarkSurface, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { useEntitlement, useNotes, useReminders, useUser } from '../../lib/hooks';
import { presentCustomerCenter, presentPaywall } from '../../lib/paywall';
import { usePapirNav } from './nav';
import { requestHistorySegment } from './PapirHistory';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function initialsFor(name: string, email: string): string {
  const src = name.trim() || email;
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function MenuRow({
  Icon,
  label,
  value,
  divider,
  onPress,
  dimmed,
}: {
  Icon: IconCmp;
  label: string;
  value?: string;
  divider: boolean;
  onPress?: () => void;
  dimmed?: boolean;
}) {
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="none"
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: 16,
        borderTopWidth: divider ? 1 : 0,
        borderTopColor: papirColor.line,
        opacity: dimmed ? 0.45 : 1,
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

const TIER_LABEL: Record<string, string> = { free: 'Prøv gratis', lite: 'Lite', pro: 'Pro' };

export function PapirProfile() {
  const nav = usePapirNav();
  const pads = usePapirScreenPads();
  const { user, signOut } = useAuth();
  const { data: profile } = useUser();
  const entitlement = useEntitlement();
  const notes = useNotes();
  const reminders = useReminders();

  const loggedIn = !!user;
  const name = profile?.name ?? '';
  const email = profile?.email ?? '';
  const isPro = entitlement.data.tier === 'pro';

  const stats = useMemo<[string, string][]>(() => {
    const voice = notes.data.filter((n) => n.source === 'voice').length;
    const textNotes = notes.data.length - voice;
    return [
      [String(voice), voice === 1 ? 'Optagelse' : 'Optagelser'],
      [String(textNotes), textNotes === 1 ? 'Note' : 'Noter'],
      [String(reminders.data.length), reminders.data.length === 1 ? 'Opgave' : 'Opgaver'],
    ];
  }, [notes.data, reminders.data]);

  const openPremium = async () => {
    if (isPro) {
      void presentCustomerCenter();
      return;
    }
    // null = the paywall could not even be presented (config/network) — the
    // tap would otherwise look dead (M5). Purchase outcomes inside the
    // paywall are RevenueCat's UI; the entitlement listener picks up success.
    const result = await presentPaywall();
    if (result === null) {
      Alert.alert('Premium', 'Kunne ikke åbne Premium lige nu. Prøv igen senere.');
    }
  };

  // Apple requires a reachable restore mechanism where purchases are offered
  // (H4) — don't rely solely on the RevenueCat paywall UI having one.
  const restorePurchases = async () => {
    try {
      const info = await Purchases.restorePurchases();
      const active = Object.keys(info.entitlements.active);
      Alert.alert(
        'Gendan køb',
        active.length > 0 ? 'Dine køb er gendannet.' : 'Ingen tidligere køb fundet på denne konto.',
      );
    } catch {
      Alert.alert('Gendan køb', 'Kunne ikke gendanne køb. Tjek din forbindelse og prøv igen.');
    }
  };

  const confirmSignOut = () => {
    Alert.alert('Log ud?', email, [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Log ud', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: pads.top, paddingBottom: pads.bottom }}
      showsVerticalScrollIndicator={false}
      // Fabric quirk: this ScrollView mounts scrolled to the END (identity
      // block hidden behind the status bar) — the only Papir tab where content
      // overflows the viewport at mount. Pin the initial offset explicitly;
      // user scrolling afterwards is unaffected.
      contentOffset={{ x: 0, y: 0 }}
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
            {loggedIn ? initialsFor(name, email) : '?'}
          </PaperText>
        </View>
        <PaperText role="name" style={{ marginTop: 16 }}>
          {loggedIn ? name || email : 'Ikke logget ind'}
        </PaperText>
        <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 4 }}>
          {loggedIn ? email : 'Log ind for at se dine ting'}
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
        {stats.map(([n, l], i) => (
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

      {/* Upsell (hidden for Pro — nothing to upsell) */}
      {!isPro ? (
        <ScaleButton
          scaleTo={0.985}
          haptic="light"
          onPress={openPremium}
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
            Autonome handlinger, åbne løkker og mere.
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
      ) : null}

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
        <MenuRow Icon={Settings} label="Indstillinger" divider={false} onPress={() => nav.push('settings')} />
        <MenuRow Icon={Bot} label="Zolva Agent" divider onPress={() => nav.push('agent')} />
        <MenuRow
          Icon={Crown}
          label="Zolva Premium"
          value={TIER_LABEL[entitlement.data.tier] ?? entitlement.data.tier}
          divider
          onPress={openPremium}
        />
        <MenuRow Icon={RotateCcw} label="Gendan køb" divider onPress={() => void restorePurchases()} />
        <MenuRow
          Icon={FileText}
          label="Mine noter"
          divider
          onPress={() => {
            requestHistorySegment(1);
            nav.setTab('history');
          }}
        />
        {/* Parity backlog: data export + support get real destinations later.
            "Kommer snart" so the dimmed rows read as roadmap, not breakage. */}
        <MenuRow Icon={Download} label="Eksportér data" value="Kommer snart" divider dimmed />
        <MenuRow Icon={HelpCircle} label="Hjælp & support" value="Kommer snart" divider dimmed />
      </View>

      <View style={{ paddingHorizontal: papirSpace.screen, marginTop: papirSpace.xl }}>
        {loggedIn ? (
          <Button label="Log ud" variant="ghost" onPress={confirmSignOut} />
        ) : (
          <Button label="Log ind" variant="primary" onPress={() => nav.openAuth()} />
        )}
      </View>
    </ScrollView>
  );
}
