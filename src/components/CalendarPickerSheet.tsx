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
import { colors } from '../theme';
import { useCalendarVisibility } from '../lib/calendar-visibility';
import {
  listGoogleCalendars,
  listIcloudCalendars,
  listMicrosoftCalendars,
  type ProviderCalendar,
} from '../lib/calendar-providers';
import { useIcloudConnected } from '../lib/hooks';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';

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
  const { t, type, fonts, radius, spacing, surface } = useTheme();

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
      {/* Halo background */}
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <GlassHaloLayer />
      </View>

      <SafeAreaView style={[styles.root, { backgroundColor: t.paper }]}>
        {/* Header glass card */}
        <View
          style={{
            paddingHorizontal: spacing.screenPad,
            paddingTop: spacing.lg,
            paddingBottom: spacing.sm,
          }}
        >
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Luk"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: t.ink2 }}>×</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontFamily: fonts.display,
                    fontSize: 20,
                    fontWeight: '600',
                    letterSpacing: -0.4,
                    color: t.ink,
                  }}
                >
                  Vælg kalendere
                </Text>
              </View>
              {/* "Færdig" action */}
              <Pressable
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.inbox }}>
                  Færdig
                </Text>
              </Pressable>
            </View>
          </GlassFrostedCard>
        </View>

        {/* Calendar list */}
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.xxl + 16,
            gap: spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
        >
          {allIdle && (
            <GlassFrostedCard overlay={surface.bone} style={{ padding: spacing.lg }}>
              <Text style={{ ...type.body, color: t.ink3, textAlign: 'center' }}>
                Ingen forbundne konti. Forbind Google, Outlook eller iCloud først.
              </Text>
            </GlassFrostedCard>
          )}

          <ProviderSection
            label="Google"
            state={google}
            visibility={visibility.google ?? []}
            onToggle={(id, hidden) => setHidden('google', id, hidden)}
            onReauthorize={isScopeError(google) ? () => { void signInWithGoogle(); } : undefined}
            t={t}
            type={type}
            fonts={fonts}
            radius={radius}
            spacing={spacing}
            surface={surface}
          />
          <ProviderSection
            label="Outlook"
            state={microsoft}
            visibility={visibility.microsoft ?? []}
            onToggle={(id, hidden) => setHidden('microsoft', id, hidden)}
            onReauthorize={isScopeError(microsoft) ? () => { void signInWithMicrosoft(); } : undefined}
            t={t}
            type={type}
            fonts={fonts}
            radius={radius}
            spacing={spacing}
            surface={surface}
          />
          <ProviderSection
            label="iCloud"
            state={icloud}
            visibility={visibility.icloud ?? []}
            onToggle={(id, hidden) => setHidden('icloud', id, hidden)}
            t={t}
            type={type}
            fonts={fonts}
            radius={radius}
            spacing={spacing}
            surface={surface}
          />
        </ScrollView>
      </SafeAreaView>
    </Animated.View>
  );
}

// ── ProviderSection ───────────────────────────────────────────────────────────

type ThemeSlice = {
  t: ReturnType<typeof useTheme>['t'];
  type: ReturnType<typeof useTheme>['type'];
  fonts: ReturnType<typeof useTheme>['fonts'];
  radius: ReturnType<typeof useTheme>['radius'];
  spacing: ReturnType<typeof useTheme>['spacing'];
  surface: ReturnType<typeof useTheme>['surface'];
};

function ProviderSection({
  label,
  state,
  visibility,
  onToggle,
  onReauthorize,
  t,
  type,
  fonts,
  radius,
  spacing,
  surface,
}: {
  label: string;
  state: ProviderState;
  visibility: string[];
  onToggle: (calendarId: string, hidden: boolean) => Promise<void>;
  onReauthorize?: () => void;
} & ThemeSlice) {
  if (state.kind === 'idle') return null;

  return (
    <View style={{ gap: spacing.sm }}>
      <Text
        style={{
          ...type.eyebrow,
          color: t.ink3,
          fontWeight: '600',
          paddingHorizontal: spacing.xs,
        }}
      >
        {label}
      </Text>

      <GlassFrostedCard overlay={surface.bone} style={{ paddingVertical: 0, paddingHorizontal: spacing.lg }}>
        {state.kind === 'loading' && (
          <View style={{ paddingVertical: spacing.xl, alignItems: 'center' }}>
            <ActivityIndicator color={t.ink3} />
          </View>
        )}

        {state.kind === 'error' && (
          <View style={{ paddingVertical: spacing.lg, gap: spacing.md }}>
            <View
              style={{
                padding: spacing.md,
                borderRadius: radius.cardSm,
                backgroundColor: surface.warningTint,
              }}
            >
              <Text style={{ ...type.bodySm, color: t.today, lineHeight: 18 }}>
                {onReauthorize
                  ? `${label} mangler tilladelse til at vise kalenderlisten. Genaktivér forbindelsen.`
                  : `Kunne ikke hente ${label}: ${state.message}`}
              </Text>
            </View>
            {onReauthorize && (
              <Pressable
                onPress={onReauthorize}
                style={{
                  alignSelf: 'flex-start',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: radius.pill,
                  backgroundColor: t.ink,
                }}
                accessibilityRole="button"
              >
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: surface.glassDarkText }}>
                  Genaktivér {label}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {state.kind === 'ok' && state.calendars.length === 0 && (
          <View style={{ paddingVertical: spacing.lg }}>
            <Text style={{ ...type.body, color: t.ink3 }}>
              Ingen kalendere fundet i {label}.
            </Text>
          </View>
        )}

        {state.kind === 'ok' && state.calendars
          .slice()
          .sort((a, b) => {
            if (a.isMainAccount !== b.isMainAccount) return a.isMainAccount ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .map((c, i, arr) => {
            const hidden = visibility.includes(c.id);
            return (
              <View
                key={`${c.provider}:${c.id}`}
                style={[
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingVertical: 12,
                  },
                  i > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: t.line,
                  },
                ]}
              >
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    backgroundColor: c.color ?? t.ink4,
                  }}
                />
                <Text
                  style={{ flex: 1, fontFamily: fonts.ui, fontSize: 15, color: t.ink }}
                  numberOfLines={1}
                >
                  {c.name}
                </Text>
                <Switch
                  value={!hidden}
                  onValueChange={(next) => { void onToggle(c.id, !next); }}
                  trackColor={{ false: t.line, true: colors.success }}
                  thumbColor={surface.glassRim}
                />
              </View>
            );
          })}
      </GlassFrostedCard>
    </View>
  );
}

const styles = StyleSheet.create({
  absoluteFill: { ...StyleSheet.absoluteFillObject, zIndex: 100 },
  root: { flex: 1 },
});
