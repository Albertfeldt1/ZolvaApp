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
// Visual style mirrors OnboardingChatQuestionsScreen for onboarding
// flow consistency.
//
// NOTE: bulkUpdatePendingFacts uses status:'confirmed' (NOT 'accepted')
// to match the live FactStatus check constraint in the facts table.

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { subscribeUserId } from '../lib/auth';
import { invalidatePreamble } from '../lib/profile';
import {
  bulkUpdatePendingFacts,
  listPendingFactsForReview,
} from '../lib/profile-store';
import type { Fact } from '../lib/types';
import { colors, fonts } from '../theme';

type Props = {
  onDone: () => void;
};

const SOURCE_GROUP_LABELS: Record<string, string> = {
  'backfill:google:mail': 'Fra Gmail',
  'backfill:microsoft:mail': 'Fra Outlook',
  'backfill:google:calendar': 'Fra Google Kalender',
  'backfill:microsoft:calendar': 'Fra Outlook Kalender',
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
  'Fra Google Kalender',
  'Fra Outlook Kalender',
  'Fra dine svar',
  'Fra chat',
  'Andet',
];

export function OnboardingFactReviewScreen({ onDone }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();

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
      // Stay on screen so the user can retry.
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
      <View style={[styles.flex, styles.center]}>
        <ActivityIndicator color={colors.sageDeep} />
      </View>
    );
  }

  if (facts.length === 0) {
    return (
      <View style={styles.flex}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
          showsVerticalScrollIndicator={false}
          bounces={false}
          overScrollMode="never"
        >
          <View style={styles.hero}>
            <Text style={styles.eyebrow}>HUKOMMELSE</Text>
            <Text style={styles.heroH1}>Vi fandt ikke noget endnu</Text>
          </View>
          <View style={styles.section}>
            <Text style={styles.body}>
              Det kommer i takt med, at du bruger Zolva. Du kan altid se og redigere det i Husk-fanen.
            </Text>
            <Pressable
              onPress={onDone}
              style={styles.primaryBtn}
              accessibilityRole="button"
            >
              <Text style={styles.primaryBtnText}>Færdig</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  const checkedCount = accepted.size;

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 100 }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>HUKOMMELSE</Text>
          <Text style={styles.heroH1}>Hvad jeg har lært om dig</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.body}>
            Sæt flueben ved det jeg skal huske, og fjern resten.
          </Text>

          {groupedSections.map(({ label, rows }) => (
            <View key={label} style={styles.group}>
              <Text style={styles.groupLabel}>{label}</Text>
              {rows.map((f) => {
                const checked = accepted.has(f.id);
                return (
                  <Pressable
                    key={f.id}
                    onPress={() => toggle(f.id)}
                    style={[styles.factRow, checked && styles.factRowChecked]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                  >
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                      {checked && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <View style={styles.factBody}>
                      <Text style={styles.factText}>{f.text}</Text>
                      <Text style={styles.factMeta}>{f.category}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: chromeBottom + 16 }]}>
        <Pressable
          onPress={save}
          disabled={saving}
          style={[styles.primaryBtn, saving && styles.primaryBtnDisabled]}
          accessibilityRole="button"
        >
          <Text style={styles.primaryBtnText}>
            {saving ? 'Gemmer…' : `Gem ${checkedCount} fakta`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },
  center: { justifyContent: 'center', alignItems: 'center' },
  scroll: { flexGrow: 1, backgroundColor: colors.paper },
  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12,
    fontFamily: fonts.displayItalic,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -1,
    color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  group: {
    marginTop: 24,
  },
  groupLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
    marginBottom: 10,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.mist,
    marginBottom: 8,
  },
  factRowChecked: {
    backgroundColor: colors.sageSoft,
    borderColor: colors.sageDeep,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.fg3,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    borderColor: colors.sageDeep,
    backgroundColor: colors.sageDeep,
  },
  checkmark: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    lineHeight: 16,
    color: colors.paper,
  },
  factBody: {
    flex: 1,
    gap: 4,
  },
  factText: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 21,
    color: colors.ink,
  },
  factMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: colors.paperOn90,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  primaryBtn: {
    marginTop: 16,
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    color: colors.paper,
  },
});
