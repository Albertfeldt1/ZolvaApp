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
import {
  listGoogleCalendars,
  listIcloudCalendars,
  listMicrosoftCalendars,
  type ProviderCalendar,
} from '../lib/calendar-providers';
import { useIcloudConnected } from '../lib/hooks';
import { colors, fonts } from '../theme';

// When the calendarList endpoint returns 403 it almost always means the
// user authorized Google before we added calendar.calendarlist.readonly to
// the scope list — the only fix is a full re-OAuth, not a refresh.
function isScopeError(state: ProviderState): boolean {
  return state.kind === 'error' && /\b403\b/.test(state.message);
}

type Props = {
  visible: boolean;
  onClose: () => void;
};

const PROVIDER_LABEL: Record<ProviderCalendar['provider'], string> = {
  google: 'Google',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

type ProviderState =
  | { kind: 'idle' }       // connected? unknown — usually means not signed in for this provider
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; calendars: ProviderCalendar[] };

// Account-grouped picker matching Apple Calendar's "Calendars" sheet:
// switch per row, color dot, name. Hidden state lives in AsyncStorage via
// useCalendarVisibility — flipping a switch immediately bumps every
// useCalendarItems consumer that opted into respectVisibility.
//
// Per-provider fetch (not aggregated through listAllCalendars) so a 401 on
// Google doesn't collapse with iCloud's empty list into a misleading
// "no calendars found" — the user needs to know which provider broke.
export function CalendarPickerSheet({ visible, onClose }: Props) {
  const { user, googleAccessToken, microsoftAccessToken, signInWithGoogle, signInWithMicrosoft } = useAuth();
  const userId = user?.id ?? '';
  const icloudConnected = useIcloudConnected(userId);
  const { visibility, setHidden } = useCalendarVisibility(userId);

  const [google, setGoogle] = useState<ProviderState>({ kind: 'idle' });
  const [microsoft, setMicrosoft] = useState<ProviderState>({ kind: 'idle' });
  const [icloud, setIcloud] = useState<ProviderState>({ kind: 'idle' });

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    if (googleAccessToken) {
      setGoogle({ kind: 'loading' });
      listGoogleCalendars({ writableOnly: false })
        .then((cals) => { if (!cancelled) setGoogle({ kind: 'ok', calendars: cals }); })
        .catch((err: Error) => {
          if (cancelled) return;
          if (__DEV__) console.warn('[picker] Google list failed:', err.message);
          setGoogle({ kind: 'error', message: err.message });
        });
    } else {
      setGoogle({ kind: 'idle' });
    }

    if (microsoftAccessToken) {
      setMicrosoft({ kind: 'loading' });
      listMicrosoftCalendars({ writableOnly: false })
        .then((cals) => { if (!cancelled) setMicrosoft({ kind: 'ok', calendars: cals }); })
        .catch((err: Error) => {
          if (cancelled) return;
          if (__DEV__) console.warn('[picker] Microsoft list failed:', err.message);
          setMicrosoft({ kind: 'error', message: err.message });
        });
    } else {
      setMicrosoft({ kind: 'idle' });
    }

    if (icloudConnected && userId) {
      setIcloud({ kind: 'loading' });
      listIcloudCalendars(userId)
        .then((cals) => { if (!cancelled) setIcloud({ kind: 'ok', calendars: cals }); })
        .catch((err: Error) => {
          if (cancelled) return;
          if (__DEV__) console.warn('[picker] iCloud list failed:', err.message);
          setIcloud({ kind: 'error', message: err.message });
        });
    } else {
      setIcloud({ kind: 'idle' });
    }

    return () => { cancelled = true; };
  }, [visible, googleAccessToken, microsoftAccessToken, icloudConnected, userId]);

  if (!visible) return null;

  const allIdle = google.kind === 'idle' && microsoft.kind === 'idle' && icloud.kind === 'idle';

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
          {allIdle && (
            <Text style={styles.empty}>Ingen forbundne konti. Forbind Google, Outlook eller iCloud først.</Text>
          )}
          <ProviderSection
            label="Google"
            state={google}
            visibility={visibility.google ?? []}
            onToggle={(id, hidden) => setHidden('google', id, hidden)}
            onReauthorize={isScopeError(google) ? () => { void signInWithGoogle(); } : undefined}
          />
          <ProviderSection
            label="Outlook"
            state={microsoft}
            visibility={visibility.microsoft ?? []}
            onToggle={(id, hidden) => setHidden('microsoft', id, hidden)}
            onReauthorize={isScopeError(microsoft) ? () => { void signInWithMicrosoft(); } : undefined}
          />
          <ProviderSection
            label="iCloud"
            state={icloud}
            visibility={visibility.icloud ?? []}
            onToggle={(id, hidden) => setHidden('icloud', id, hidden)}
          />
        </ScrollView>
      </SafeAreaView>
    </Animated.View>
  );
}

function ProviderSection({
  label,
  state,
  visibility,
  onToggle,
  onReauthorize,
}: {
  label: string;
  state: ProviderState;
  visibility: string[];
  onToggle: (calendarId: string, hidden: boolean) => Promise<void>;
  onReauthorize?: () => void;
}) {
  if (state.kind === 'idle') return null;

  return (
    <View style={styles.group}>
      <Text style={styles.groupHeading}>{label}</Text>
      {state.kind === 'loading' && (
        <View style={styles.center}><ActivityIndicator color={colors.fg3} /></View>
      )}
      {state.kind === 'error' && (
        <View style={styles.errorBlock}>
          <Text style={styles.error}>
            {onReauthorize
              ? `${label} mangler tilladelse til at vise kalenderlisten. Genaktivér forbindelsen.`
              : `Kunne ikke hente ${label}: ${state.message}`}
          </Text>
          {onReauthorize && (
            <Pressable onPress={onReauthorize} style={styles.errorCta} accessibilityRole="button">
              <Text style={styles.errorCtaText}>Genaktivér {label}</Text>
            </Pressable>
          )}
        </View>
      )}
      {state.kind === 'ok' && state.calendars.length === 0 && (
        <Text style={styles.empty}>Ingen kalendere fundet i {label}.</Text>
      )}
      {state.kind === 'ok' && state.calendars
        .slice()
        .sort((a, b) => {
          if (a.isMainAccount !== b.isMainAccount) return a.isMainAccount ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((c) => {
          const hidden = visibility.includes(c.id);
          return (
            <View key={`${c.provider}:${c.id}`} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: c.color ?? colors.fg4 }]} />
              <Text style={styles.rowName} numberOfLines={1}>{c.name}</Text>
              <Switch
                value={!hidden}
                onValueChange={(next) => { void onToggle(c.id, !next); }}
                trackColor={{ false: colors.line, true: colors.sage }}
                thumbColor={colors.paper}
              />
            </View>
          );
        })}
    </View>
  );
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
  center: { paddingVertical: 24, alignItems: 'center' },
  error: { fontFamily: fonts.ui, fontSize: 13, lineHeight: 18, color: colors.warningInk },
  errorBlock: {
    gap: 10,
    padding: 12,
    backgroundColor: colors.warningSoft,
    borderRadius: 10,
  },
  errorCta: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  errorCtaText: { fontFamily: fonts.uiSemi, fontSize: 13, color: colors.paper },
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
