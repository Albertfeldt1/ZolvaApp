/**
 * OpenLoopsModal — full-screen Animated.View overlay (NOT a native <Modal>)
 * listing the open loops the agent is tracking: promises the user owes a reply
 * on (you_owe) and replies the user is still waiting for (owed_to_you).
 *
 * Read-only in this slice — loops are opened and closed server-side by the
 * agent-commitments sweep (Phase 2 reconcile), so there is no approve/dismiss
 * affordance here. Overlay pattern matches ProposalDetailModal: absolute-fill
 * Animated.View mounted outside the ScrollView in TodayScreen so it is never
 * clipped, and an Animated.View (never a racing native <Modal>).
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '../design/useTheme';
import { useChromeInsets } from './PhoneChrome';
import { Stone } from './Stone';
import { colors } from '../theme';
import type { CommitmentRow } from '../lib/agent-commitments';

export type Props = {
  rows: CommitmentRow[];
  onClose: () => void;
};

function formatDanishDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('da-DK', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/Copenhagen',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// One-line context under each loop. you_owe leans on the (possibly inferred)
// due date; owed_to_you leans on how long the user has been waiting.
function metaLine(row: CommitmentRow): string {
  if (row.direction === 'you_owe') {
    if (!row.due_at) return 'Ingen frist';
    const prefix = row.due_inferred ? 'Senest ca. ' : 'Senest ';
    return prefix + formatDanishDate(row.due_at);
  }
  return 'Venter siden ' + formatDanishDate(row.created_at);
}

function LoopCard({ row }: { row: CommitmentRow }) {
  const { surface, shadows } = useTheme();
  const who = row.counterparty || 'nogen';
  return (
    <View
      style={[styles.card, { backgroundColor: surface.bone, borderColor: surface.glassRim, ...shadows.softCard }]}
      accessibilityLabel={`open-loop-${row.direction}`}
    >
      <Text style={styles.cardWho}>{who}</Text>
      <Text style={styles.cardSummary}>{row.summary}</Text>
      <Text style={styles.cardMeta}>{metaLine(row)}</Text>
    </View>
  );
}

export function OpenLoopsModal({ rows, onClose }: Props) {
  const { surface, shadows } = useTheme();
  const { bottom: chromeBottom } = useChromeInsets();

  const youOwe = rows.filter((r) => r.direction === 'you_owe');
  const owedToYou = rows.filter((r) => r.direction === 'owed_to_you');
  const isEmpty = rows.length === 0;

  return (
    <Animated.View
      style={styles.overlay}
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(150)}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Luk" />

      <View style={styles.safeArea} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: surface.bone, borderColor: surface.glassRim, ...shadows.softCard },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>Åbne loops</Text>
            <Pressable onPress={onClose} accessibilityLabel="Luk modal" hitSlop={8}>
              <Text style={styles.closeBtn}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={[styles.contentContainer, { paddingBottom: Math.max(16, chromeBottom) }]}
            showsVerticalScrollIndicator={false}
          >
            {isEmpty ? (
              <View style={styles.emptyWrap}>
                <Stone mood="happy" size={48} jumpOnTap={false} />
                <Text style={styles.emptyTitle}>Ingen åbne loops</Text>
                <Text style={styles.emptyBody}>
                  Alt er fulgt op. Når du lover et svar — eller venter på et — holder jeg styr på det her.
                </Text>
              </View>
            ) : (
              <>
                {youOwe.length > 0 ? (
                  <>
                    <Text style={styles.groupHeading}>Du skylder svar</Text>
                    {youOwe.map((r) => (
                      <LoopCard key={r.id} row={r} />
                    ))}
                  </>
                ) : null}
                {owedToYou.length > 0 ? (
                  <>
                    <Text style={styles.groupHeading}>Du venter på svar</Text>
                    {owedToYou.map((r) => (
                      <LoopCard key={r.id} row={r} />
                    ))}
                  </>
                ) : null}
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Animated.View>
  );
}

const ABSOLUTE_FILL = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

const styles = StyleSheet.create({
  overlay: {
    ...ABSOLUTE_FILL,
    zIndex: 1000,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...ABSOLUTE_FILL,
    backgroundColor: 'rgba(11,11,12,0.45)',
  },
  safeArea: {
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingTop: 16,
    paddingBottom: 8,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(11,11,12,0.10)',
  },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
    flex: 1,
  },
  closeBtn: {
    color: colors.fg3,
    fontSize: 16,
    paddingLeft: 12,
  },
  contentScroll: {
    flexShrink: 1,
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  groupHeading: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 2,
    marginHorizontal: 2,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 4,
    overflow: 'hidden',
  },
  cardWho: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  cardSummary: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  cardMeta: { color: colors.fg3, fontSize: 12, marginTop: 2 },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
    gap: 10,
  },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  emptyBody: { color: colors.fg3, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
