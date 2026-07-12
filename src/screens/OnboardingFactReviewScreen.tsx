// src/screens/OnboardingFactReviewScreen.tsx
//
// Final screen in the onboarding-backfill chain. Lists pending facts
// grouped by source (Gmail / Outlook / Google Kalender / Outlook
// Kalender / dine svar / chat / Andet), defaults all checked, and on
// submit flips the checked rows to 'confirmed' and the unchecked to
// 'rejected' via bulkUpdatePendingFacts. Then invalidates the preamble
// cache so the next chatbot turn rebuilds with the freshly-confirmed
// facts, and calls onDone() to advance the flow.
//
// NOTE: bulkUpdatePendingFacts uses status:'confirmed' (NOT 'accepted')
// to match the live FactStatus check constraint in the facts table.
//
// Papir-redesign — "Notesbogen, opslået": det Zolva har lært, præsenteret
// som redigerbare notater på hvide ark. Grønne flueben (behold), roligt
// blæk, Fraunces-overskrift og en flydende gem-knap i blæk. Fejlede kilder
// vises som et rust-farvet notat med "Prøv igen" — aldrig som en alarm.

import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown } from 'react-native-reanimated';
import { useChromeInsets } from '../components/PhoneChrome';
import {
  BreathingWave,
  PaperText,
  papirColor,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../design/papir';
import { ScaleButton } from '../design/motion';
import { PapirLoader } from './papir/PapirLoader';
import { subscribeUserId } from '../lib/auth';
import { invalidatePreamble } from '../lib/profile';
import { triggerBackfillRerun, type BackfillJob } from '../lib/onboarding-backfill';
import {
  BulkUpdateTimeoutError,
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

// Stable order for the section headers - keeps the screen visually
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

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => subscribeUserId(setUserId), []);

  const [facts, setFacts] = useState<Fact[]>([]);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSlow, setSavingSlow] = useState(false);

  useEffect(() => {
    if (!userId) {
      // Not signed in (shouldn't normally happen during onboarding) -
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
        // want kept by tapping to uncheck - friendlier than asking them
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
    setSavingSlow(false);
    // After 5s the save still hasn't returned: surface "Stadig i gang…"
    // so the user knows we're not frozen and waits a beat before
    // force-quitting. The deadline inside bulkUpdatePendingFacts (20s)
    // will resolve to a real error after that.
    const slowTimer = setTimeout(() => setSavingSlow(true), 5_000);
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
      const isTimeout = e instanceof BulkUpdateTimeoutError;
      Alert.alert(
        'Kunne ikke gemme',
        isTimeout
          ? 'Forbindelsen er langsom lige nu. Tjek dit netværk og prøv igen.'
          : 'Noget gik galt. Prøv igen om et øjeblik.',
        [{ text: 'OK' }],
      );
    } finally {
      clearTimeout(slowTimer);
      setSavingSlow(false);
      setSaving(false);
    }
  };

  // Group facts by their human-readable source label, in the stable
  // GROUP_ORDER above. useMemo keeps the work out of every render even
  // though it's cheap - the screen re-renders on each toggle.
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
      <View
        style={{
          flex: 1,
          backgroundColor: papirColor.paper,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <PapirLoader />
      </View>
    );
  }

  if (facts.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <View
          style={{
            flex: 1,
            paddingHorizontal: papirSpace.screen,
            paddingTop: 76,
            paddingBottom: chromeBottom + papirSpace.xl,
          }}
        >
          <View style={{ flex: 1, justifyContent: 'center', gap: papirSpace.lg }}>
            <Animated.View entering={FadeIn.duration(700)}>
              <BreathingWave scale={0.8} />
            </Animated.View>
            <Animated.View
              entering={FadeInDown.delay(100).duration(560).easing(Easing.out(Easing.quad))}
              style={{ gap: papirSpace.md }}
            >
              <PaperText role="eyebrow" color={papirColor.ink3}>
                Hukommelse
              </PaperText>
              <PaperText role="displayM" accessibilityRole="header">
                Intet at vise endnu.
              </PaperText>
            </Animated.View>
            <Animated.View entering={FadeInDown.delay(220).duration(560).easing(Easing.out(Easing.quad))}>
              <PaperText role="bodySerif" color={papirColor.ink2}>
                Det kommer i takt med, at du bruger Zolva. Du kan altid se og rette,
                hvad jeg har lært, under Hukommelse.
              </PaperText>
            </Animated.View>
          </View>
          <ScaleButton
            scaleTo={0.97}
            haptic="light"
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel="Færdig"
            style={{
              height: 56,
              borderRadius: papirRadius.lg,
              backgroundColor: papirColor.ink,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PaperText role="button" color={papirColor.onInk}>
              Færdig
            </PaperText>
          </ScaleButton>
        </View>
      </View>
    );
  }

  const checkedCount = accepted.size;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper }]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          // Reserve room so the last list item can scroll past the
          // absolute-positioned footer instead of staying permanently
          // hidden behind it. Approx button (56) + paddings (32) +
          // home-indicator (34) ≈ 122.
          paddingBottom: 122,
          paddingHorizontal: papirSpace.screen,
          paddingTop: 76,
        }}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        {/* Overskrift */}
        <Animated.View
          entering={FadeInDown.duration(560).easing(Easing.out(Easing.quad))}
          style={{ gap: papirSpace.md }}
        >
          <PaperText role="eyebrow" color={papirColor.ink3}>
            Hukommelse
          </PaperText>
          <PaperText role="displayM" accessibilityRole="header">
            Hvad jeg har lært om dig.
          </PaperText>
          <PaperText role="bodySerif" color={papirColor.ink2}>
            Behold det, der passer — og fjern resten. Du bestemmer, hvad jeg husker.
          </PaperText>
        </Animated.View>

        {/* Fejlede kilder: et roligt rust-notat, ikke en alarm. */}
        {failedJobs.length > 0 && (
          <Animated.View
            entering={FadeInDown.delay(120).duration(480).easing(Easing.out(Easing.quad))}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: papirSpace.md,
              backgroundColor: papirColor.rustSoft,
              borderRadius: papirRadius.xxl,
              paddingVertical: papirSpace.md,
              paddingHorizontal: papirSpace.lg,
              marginTop: papirSpace.xl,
            }}
          >
            <PaperText role="small" color={papirColor.rust} style={{ flex: 1 }}>
              {`Jeg kunne ikke læse ${failedJobsLabel(failedJobs)}.`}
            </PaperText>
            <ScaleButton
              scaleTo={0.96}
              haptic="light"
              onPress={() => {
                onDone();
                triggerBackfillRerun();
              }}
              accessibilityRole="button"
              accessibilityLabel="Prøv igen"
              style={{
                paddingVertical: papirSpace.sm,
                paddingHorizontal: papirSpace.base,
                borderRadius: papirRadius.pill,
                backgroundColor: papirColor.ink,
              }}
            >
              <PaperText role="chip" color={papirColor.onInk}>
                Prøv igen
              </PaperText>
            </ScaleButton>
          </Animated.View>
        )}

        {/* Grupperede notater */}
        {groupedSections.map(({ label, rows }, sectionIdx) => (
          <Animated.View
            key={label}
            entering={FadeInDown.delay(Math.min(160 + sectionIdx * 80, 480))
              .duration(480)
              .easing(Easing.out(Easing.quad))}
            style={{ gap: papirSpace.sm, marginTop: papirSpace.xl }}
          >
            <PaperText role="eyebrow" color={papirColor.ink3} style={{ paddingLeft: papirSpace.xs }}>
              {label}
            </PaperText>
            <View
              style={{
                backgroundColor: papirColor.card,
                borderRadius: papirRadius.xxl,
                paddingHorizontal: papirSpace.lg,
                ...papirShadow.sm,
              }}
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
                      gap: papirSpace.md,
                      paddingVertical: papirSpace.base,
                      borderTopWidth: i > 0 ? 1 : 0,
                      borderTopColor: papirColor.lineSoft,
                    }}
                  >
                    {/* Flueben: grønt = behold. Ufravalgt = tom kontur. */}
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 7,
                        borderWidth: 1.5,
                        borderColor: checked ? papirColor.green : papirColor.ink4,
                        backgroundColor: checked ? papirColor.green : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 1,
                      }}
                    >
                      {checked && (
                        <PaperText role="chip" color="#FFFFFF" style={{ lineHeight: 15 }}>
                          ✓
                        </PaperText>
                      )}
                    </View>

                    <View style={{ flex: 1, gap: papirSpace.xs }}>
                      <PaperText
                        role="body"
                        color={checked ? papirColor.ink : papirColor.ink3}
                      >
                        {f.text}
                      </PaperText>
                      <PaperText role="eyebrow" color={papirColor.ink4} style={{ letterSpacing: 0.8 }}>
                        {f.category}
                      </PaperText>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </Animated.View>
        ))}
      </ScrollView>

      {/* Flydende gem-knap i blæk. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: chromeBottom + papirSpace.lg,
          paddingHorizontal: papirSpace.screen,
        }}
      >
        <ScaleButton
          scaleTo={0.97}
          haptic="medium"
          onPress={save}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Gem"
          accessibilityState={{ disabled: saving, busy: saving }}
          style={{
            height: 56,
            borderRadius: papirRadius.pill,
            backgroundColor: papirColor.ink,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: saving ? 0.5 : 1,
            ...papirShadow.ink,
          }}
        >
          <PaperText role="button" color={papirColor.onInk}>
            {saving
              ? savingSlow
                ? 'Stadig i gang…'
                : 'Gemmer…'
              : checkedCount === 1
                ? 'Husk 1 ting'
                : `Husk ${checkedCount} ting`}
          </PaperText>
        </ScaleButton>
      </View>
    </View>
  );
}
