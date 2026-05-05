import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useAuth } from '../lib/auth';
import { useCalendarVisibility } from '../lib/calendar-visibility';
import { listAllCalendars, type ProviderCalendar } from '../lib/calendar-providers';
import { useIcloudConnected } from '../lib/hooks';
import { colors, fonts } from '../theme';

type Props = {
  visible: boolean;
  onClose: () => void;
};

const PROVIDER_LABEL: Record<ProviderCalendar['provider'], string> = {
  google: 'Google',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

// Account-grouped picker matching Apple Calendar's "Calendars" sheet:
// switch per row, color dot, name. Hidden state lives in AsyncStorage via
// useCalendarVisibility — flipping a switch immediately bumps every
// useCalendarItems consumer that opted into respectVisibility.
export function CalendarPickerSheet({ visible, onClose }: Props) {
  const { user, googleAccessToken, microsoftAccessToken } = useAuth();
  const userId = user?.id ?? '';
  const icloudConnected = useIcloudConnected(userId);
  const { visibility, setHidden } = useCalendarVisibility(userId);

  const [calendars, setCalendars] = useState<ProviderCalendar[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setCalendars(null);
    setLoadError(null);
    void listAllCalendars({
      hasGoogle: !!googleAccessToken,
      hasMicrosoft: !!microsoftAccessToken,
      hasIcloud: icloudConnected,
      userId,
    })
      .then((list) => { if (!cancelled) setCalendars(list); })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => { cancelled = true; };
  }, [visible, googleAccessToken, microsoftAccessToken, icloudConnected, userId]);

  if (!visible) return null;

  // Group by accountEmail (or provider name when no email — typical for
  // iCloud where the CalDAV reader doesn't surface the account address).
  const groups = groupByAccount(calendars ?? []);

  return (
    <Animated.View
      style={styles.absoluteFill}
      entering={SlideInDown.duration(320)}
      exiting={SlideOutDown.duration(260)}
    >
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Kalendere</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.close}>Færdig</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {calendars === null && !loadError && (
            <View style={styles.center}><ActivityIndicator color={colors.fg3} /></View>
          )}
          {loadError && (
            <Text style={styles.error}>Kunne ikke hente kalendere — prøv igen.</Text>
          )}
          {calendars !== null && calendars.length === 0 && !loadError && (
            <Text style={styles.empty}>Ingen kalendere fundet. Forbind en konto først.</Text>
          )}
          {groups.map(({ heading, providerLabel, items }) => (
            <View key={heading} style={styles.group}>
              <Text style={styles.groupHeading}>{providerLabel}{heading ? ` · ${heading}` : ''}</Text>
              {items.map((c) => {
                const hidden = (visibility[c.provider] ?? []).includes(c.id);
                return (
                  <View key={`${c.provider}:${c.id}`} style={styles.row}>
                    <View style={[styles.dot, { backgroundColor: c.color ?? colors.fg4 }]} />
                    <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
                    <Switch
                      value={!hidden}
                      onValueChange={(next) => { void setHidden(c.provider, c.id, !next); }}
                      trackColor={{ false: colors.line, true: colors.sage }}
                      thumbColor={colors.paper}
                    />
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Animated.View>
  );
}

type Group = { heading: string; providerLabel: string; items: ProviderCalendar[] };

function groupByAccount(calendars: ProviderCalendar[]): Group[] {
  // Provider order matches the connect-flow priority (Google, Outlook,
  // iCloud) so the picker doesn't reshuffle each open.
  const providerOrder: ProviderCalendar['provider'][] = ['google', 'microsoft', 'icloud'];
  const groups: Group[] = [];
  for (const provider of providerOrder) {
    const forProvider = calendars.filter((c) => c.provider === provider);
    if (forProvider.length === 0) continue;
    // For iCloud the email is null on every row; collapse into one group.
    const accounts = new Map<string, ProviderCalendar[]>();
    for (const c of forProvider) {
      const key = c.accountEmail ?? '';
      const list = accounts.get(key) ?? [];
      list.push(c);
      accounts.set(key, list);
    }
    for (const [email, items] of accounts) {
      groups.push({
        heading: email,
        providerLabel: PROVIDER_LABEL[provider],
        // Main account first, then alphabetical — nicer when a user has 8
        // shared calendars on top of their own.
        items: items.sort((a, b) => {
          if (a.isMainAccount !== b.isMainAccount) return a.isMainAccount ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      });
    }
  }
  return groups;
}

const styles = StyleSheet.create({
  absoluteFill: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  root: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  title: { fontFamily: fonts.displayItalic, fontSize: 22, letterSpacing: -0.3, color: colors.ink },
  close: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.sageDeep },
  body: { padding: 20, gap: 24, paddingBottom: 40 },
  center: { paddingVertical: 40, alignItems: 'center' },
  error: { fontFamily: fonts.ui, fontSize: 14, color: colors.warningInk },
  empty: { fontFamily: fonts.ui, fontSize: 14, color: colors.fg3 },
  group: { gap: 8 },
  groupHeading: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  rowName: { flex: 1, fontFamily: fonts.ui, fontSize: 15, color: colors.ink },
});
