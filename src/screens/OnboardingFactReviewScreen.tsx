// src/screens/OnboardingFactReviewScreen.tsx
//
// Final screen in the onboarding-backfill chain. Lists pending facts
// grouped by source (Gmail / Outlook / Google Kalender / Outlook
// Kalender / dine svar / chat / Andet), defaults all checked, and on
// submit flips the checked rows to 'confirmed' and the unchecked to
// 'rejected' via bulkUpdatePendingFacts. Then invalidates the preamble
// cache so the next chatbot turn rebuilds with the freshly-confirmed
// facts, and calls onDone() to advance the flow. Wiring into App.tsx
// is Task 13.
//
// NOTE: bulkUpdatePendingFacts uses status:'confirmed' (NOT 'accepted')
// to match the live FactStatus check constraint in the facts table.
//
// Migrated to Glass & Air design system.

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { subscribeUserId } from '../lib/auth';
import { invalidatePreamble } from '../lib/profile';
import { triggerBackfillRerun, type BackfillJob } from '../lib/onboarding-backfill';
import {
  bulkUpdatePendingFacts,
  listPendingFactsForReview,
} from '../lib/profile-store';
import type { Fact } from '../lib/types';

type Props = {
  onDone: () => void;
  failedJobs?: BackfillJob[];
};

const FAILED_LABEL: Record<string, string> = {
  'google:mail': 'Gmail',
  'google:calendar': 'Google Kalender',
  'microsoft:mail': 'Outlook',
  'microsoft:calendar': 'Outlook Kalender',
};

function failedJobsLabel(jobs: BackfillJob[]): string {
  const names = Array.from(
    new Set(jobs.map((j) => FAILED_LABEL[`${j.provider}:${j.kind}`] ?? `${j.provider} ${j.kind}`)),
  );
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} og ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} og ${names[names.length - 1]}`;
}

const SOURCE_GROUP_LABELS: Record<string, string> = {
  'backfill:google:mail': 'Fra Gmail',
  'backfill:microsoft:mail': 'Fra Outlook',
  'backfill:icloud:mail': 'Fra iCloud',
  'backfill:google:calendar': 'Fra Google Kalender',
  'backfill:microsoft:calendar': 'Fra Outlook Kalender',
  'backfill:google:drive': 'Fra Google Drive',
};

function groupLabel(source: string | null | undefined): string {
  if (!source) return 'Andet';
  if (SOURCE_GROUP_LABELS[source]) return SOURCE_GROUP_LABELS[source];
  if (source.startsWith('onboarding:')) return 'Fra dine svar';
  if (source.startsWith('chat:')) return 'Fra chat';
  return 'Andet';
}

// Stable order for the section headers — keeps the screen visually
// predictable regardless of how the rows happen to come back from
// Supabase.
const GROUP_ORDER = [
  'Fra Gmail',
  'Fra Outlook',
  'Fra iCloud',
  'Fra Google Kalender',
  'Fra Outlook Kalender',
  'Fra Google Drive',
  'Fra dine svar',
  'Fra chat',
  'Andet',
];

export function OnboardingFactReviewScreen({ onDone, failedJobs = [] }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();
  const { t, type, fonts, radius, spacing, surface } = useTheme();

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => subscribeUserId(setUserId), []);

  const [facts, setFacts] = useState<Fact[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId) {
      // Not signed in (shouldn't normally happen during onboarding) —
      // bail out of the loading state so the empty-state UI renders
      // instead of an indefinite spinner.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void listPendingFactsForReview(userId)
      .then((rows) => {
        if (cancelled) return;
        setFacts(rows);
        // Default: ALL checked. The user opts OUT of facts they don't
        // want kept by tapping to uncheck — friendlier than asking them
        // to manually confirm every single row.
        setAccepted(new Set(rows.map((r) => r.id)));
      })
      .catch((e) => {
        if (__DEV__) console.warn('[fact-review] load failed:', e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggle = (id: string) => {
    setAccepted((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (!userId || saving) return;
    setSaving(true);
    try {
      const updates = facts.map((f) => ({
        id: f.id,
        status: accepted.has(f.id) ? ('confirmed' as const) : ('rejected' as const),
      }));
      await bulkUpdatePendingFacts(userId, updates);
      invalidatePreamble(userId);
      onDone();
    } catch (e) {
      if (__DEV__) console.warn('[fact-review] save failed:', e);
      Alert.alert(
        'Kunne ikke gemme',
        'Noget gik galt. Prøv igen om et øjeblik.',
        [{ text: 'OK' }],
      );
    } finally {
      setSaving(false);
    }
  };

  // Group facts by their human-readable source label, in the stable
  // GROUP_ORDER above. useMemo keeps the work out of every render even
  // though it's cheap — the screen re-renders on each toggle.
  const groupedSections = useMemo(() => {
    const buckets = new Map<string, Fact[]>();
    for (const f of facts) {
      const key = groupLabel(f.source);
      const list = buckets.get(key);
      if (list) list.push(f);
      else buckets.set(key, [f]);
    }
    return GROUP_ORDER.flatMap((label) => {
      const rows = buckets.get(label);
      return rows && rows.length > 0 ? [{ label, rows }] : [];
    });
  }, [facts]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.paper, justifyContent: 'center', alignItems: 'center' }}>
        <GlassHaloLayer />
        <ActivityIndicator color={t.mem} />
      </View>
    );
  }

  if (facts.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: t.paper }}>
        <GlassHaloLayer />
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: chromeBottom + 32,
            paddingHorizontal: spacing.screenPad,
            paddingTop: spacing.statusBarFallback,
            gap: spacing.heroPad,
          }}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
        >
          {/* Hero */}
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            style={{
              paddingVertical: spacing.xl,
              paddingHorizontal: spacing.lg,
              alignItems: 'center',
              gap: spacing.md,
            }}
          >
            <Stone size={88} jumpOnTap={false} />
            <Text style={{ ...type.eyebrow, color: t.ink3, textAlign: 'center' }}>
              HUKOMMELSE
            </Text>
            <Text style={{ ...type.displayL, color: t.ink, textAlign: 'center' }}>
              Vi fandt ikke{'\n'}noget endnu
            </Text>
          </GlassFrostedCard>

          {/* Body */}
          <GlassFrostedCard
            style={{ paddingVertical: spacing.cardPad, paddingHorizontal: spacing.cardPad }}
          >
            <Text style={{ ...type.body, color: t.ink }}>
              Det kommer i takt med, at du bruger Zolva. Du kan altid se og redigere det i Husk-fanen.
            </Text>
          </GlassFrostedCard>

          {/* Done button */}
          <Pressable
            onPress={onDone}
            accessibilityRole="button"
            style={({ pressed }) => ({
              backgroundColor: t.ink,
              paddingVertical: 14,
              borderRadius: radius.soft,
              alignItems: 'center',
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: '#FFFFFF' }}>
              Færdig
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  const checkedCount = accepted.size;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.paper }]}>
      <GlassHaloLayer />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          // Reserve room so the last list item can scroll past the
          // absolute-positioned footer instead of staying permanently
          // hidden behind it. Approx button (44) + paddings (32) +
          // home-indicator (34) ≈ 110.
          paddingBottom: 110,
          paddingHorizontal: spacing.screenPad,
          paddingTop: spacing.statusBarFallback,
          gap: spacing.heroPad,
        }}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        {/* Hero card */}
        <GlassFrostedCard
          radius={radius.card}
          overlay={surface.bone}
          style={{
            paddingVertical: spacing.xl,
            paddingHorizontal: spacing.lg,
            alignItems: 'center',
            gap: spacing.md,
          }}
        >
          <Stone size={88} jumpOnTap={false} />
          <Text style={{ ...type.eyebrow, color: t.ink3, textAlign: 'center' }}>
            HUKOMMELSE
          </Text>
          <Text style={{ ...type.displayL, color: t.ink, textAlign: 'center' }}>
            Hvad jeg har{'\n'}lært om dig
          </Text>
        </GlassFrostedCard>

        {/* Failed-job banner */}
        {failedJobs.length > 0 && (
          <GlassFrostedCard overlay={surface.warningTint} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Text style={{ ...type.bodySm, color: t.ink, flex: 1 }}>
                {`Jeg kunne ikke læse ${failedJobsLabel(failedJobs)}.`}
              </Text>
              <Pressable
                onPress={() => {
                  onDone();
                  triggerBackfillRerun();
                }}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: radius.soft,
                  backgroundColor: t.ink,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: '#FFFFFF' }}>
                  Prøv igen
                </Text>
              </Pressable>
            </View>
          </GlassFrostedCard>
        )}

        {/* Body explainer */}
        <GlassFrostedCard
          style={{ paddingVertical: spacing.cardPad, paddingHorizontal: spacing.cardPad }}
        >
          <Text style={{ ...type.body, color: t.ink }}>
            Sæt flueben ved det jeg skal huske, og fjern resten.
          </Text>
        </GlassFrostedCard>

        {/* Grouped fact sections */}
        {groupedSections.map(({ label, rows }) => (
          <View key={label} style={{ gap: spacing.sm }}>
            {/* Section header */}
            <Text
              style={{
                ...type.eyebrow,
                color: t.ink3,
                fontFamily: fonts.mono,
                paddingHorizontal: spacing.xs,
              }}
            >
              {label}
            </Text>

            {/* All facts in this group in one card, separated by hairlines */}
            <GlassFrostedCard
              style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.cardPad }}
            >
              {rows.map((f, i) => {
                const checked = accepted.has(f.id);
                return (
                  <Pressable
                    key={f.id}
                    onPress={() => toggle(f.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: spacing.md,
                      paddingVertical: spacing.md,
                      borderTopWidth: i > 0 ? 1 : 0,
                      borderTopColor: t.line,
                    }}
                  >
                    {/* Checkbox */}
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        borderWidth: 1.5,
                        borderColor: checked ? t.mem : t.ink3,
                        backgroundColor: checked ? t.mem : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 1,
                      }}
                    >
                      {checked && (
                        <Text
                          style={{
                            fontFamily: fonts.uiBold,
                            fontSize: 13,
                            lineHeight: 16,
                            color: '#FFFFFF',
                          }}
                        >
                          ✓
                        </Text>
                      )}
                    </View>

                    {/* Fact text + category */}
                    <View style={{ flex: 1, gap: spacing.xs }}>
                      <Text style={{ ...type.body, color: t.ink, lineHeight: 21 }}>
                        {f.text}
                      </Text>
                      <Text
                        style={{
                          ...type.eyebrow,
                          color: t.ink3,
                          letterSpacing: 0.6,
                          textTransform: 'uppercase',
                        }}
                      >
                        {f.category}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </GlassFrostedCard>
          </View>
        ))}
      </ScrollView>

      {/* Floating button with a soft drop-shadow halo. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: spacing.lg + 18,
          paddingHorizontal: spacing.screenPad,
        }}
      >
        <Pressable
          onPress={save}
          disabled={saving}
          accessibilityRole="button"
          style={({ pressed }) => ({
            backgroundColor: t.ink,
            paddingVertical: 14,
            borderRadius: radius.pill,
            alignItems: 'center',
            opacity: saving ? 0.4 : pressed ? 0.8 : 1,
            shadowColor: t.ink,
            shadowOpacity: t.mode === 'dark' ? 0.55 : 0.32,
            shadowOffset: { width: 0, height: 0 },
            shadowRadius: 28,
            elevation: 12,
          })}
        >
          <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: '#FFFFFF' }}>
            {saving ? 'Gemmer…' : `Gem ${checkedCount} fakta`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
