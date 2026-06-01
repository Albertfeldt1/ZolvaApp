/**
 * AgentActionDetailModal — full-screen Animated.View overlay (NOT a native
 * <Modal>) for reviewing an already-executed agent action read-only.
 *
 * Read-only analogue of ProposalDetailModal: it shows what the agent actually
 * did (full sent/drafted email body, calendar event details, nudge text, …)
 * and offers an Undo ("Fortryd") button when the action is reversible.
 *
 * Overlay pattern: matches ProposalDetailModal — absolute-fill Animated.View
 * with fade-in, mounted outside the ScrollView in TodayScreen so it is never
 * clipped.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { revertAgentAction, type AgentActionRow } from '../lib/agent-feed';
import { TITLES } from './AgentActionCard';
import { useTheme } from '../design/useTheme';
import { useChromeInsets } from './PhoneChrome';
import { colors } from '../theme';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function formatDanishDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('da-DK', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Copenhagen',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const REPLY_TYPES = new Set([
  'mail.send_reply',
  'mail.draft_reply',
  'mail.send_new',
]);

const CAL_TYPES = new Set([
  'cal.create_event',
  'cal.update_event',
]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type Props = {
  row: AgentActionRow;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentActionDetailModal({ row, onClose }: Props) {
  const { surface, shadows } = useTheme();
  const { bottom: chromeBottom } = useChromeInsets();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const type = row.action_type as string;
  const isReply = REPLY_TYPES.has(type);
  const isCal = CAL_TYPES.has(type);
  const isDraft = type === 'mail.draft_reply';
  const isReverted = !!row.reversed_at;

  // -------------------------------------------------------------------------
  // Undo handler — mirrors AgentActionCard.onUndo
  // -------------------------------------------------------------------------

  async function handleUndo() {
    setPending(true);
    setError(null);
    const r = await revertAgentAction(row.id);
    setPending(false);
    if (r.ok) {
      onClose();
    } else {
      setError(r.error ?? 'fejl');
    }
  }

  // -------------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------------

  const modalTitle = TITLES[type] ?? 'Handling udført';

  // Reply / mail fields
  const replyTo = str(row.payload.to);
  const replySubject = str(row.payload.subject);
  const replyBody = str(row.payload.body_full) || str(row.payload.body_preview);

  // Calendar fields
  const calTitle = str(row.payload.title);
  const calStart = str(row.payload.start_iso);
  const calEnd = str(row.payload.end_iso);
  const calLocation = str(row.payload.location);
  const calAttendees = Array.isArray(row.payload.attendees)
    ? (row.payload.attendees as unknown[]).map(str).filter(Boolean).join(', ')
    : '';
  const calDateTime =
    calStart && calEnd
      ? `${formatDanishDateTime(calStart)} – ${formatDanishDateTime(calEnd)}`
      : calStart
        ? formatDanishDateTime(calStart)
        : '';

  // Nudge fields
  const nudgeTitle = str(row.payload.title);
  const nudgeBody = str(row.payload.body);

  // Summarise / label
  const summary = str(row.payload.summary);
  const labelText = str(row.payload.label);
  const labelOp = str(row.payload.op);

  // Original incoming message (context) — shown muted, mirrors ProposalDetailModal
  const sourceFrom = str(row.payload.source_from);
  const sourceBody = str(row.payload.source_body);

  // Fallback detail text — mirrors AgentActionCard.detailFor for graceful display
  const fallbackDetail = (() => {
    if (summary) return summary;
    if (labelText) {
      return `${labelOp === 'remove' ? 'Fjernet' : 'Tilføjet'}: ${labelText}`;
    }
    return '';
  })();

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Animated.View
      style={styles.overlay}
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(150)}
    >
      {/* Dimmed backdrop — tap outside sheet to close */}
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Luk" />

      <View style={styles.safeArea} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: surface.bone,
              borderColor: surface.glassRim,
              ...shadows.softCard,
            },
          ]}
        >
          {/* Header row */}
          <View style={styles.header}>
            <Text style={styles.title}>{modalTitle}</Text>
            <Pressable onPress={onClose} accessibilityLabel="Luk modal" hitSlop={8}>
              <Text style={styles.closeBtn}>✕</Text>
            </Pressable>
          </View>

          {/* Scrollable content */}
          <ScrollView
            style={styles.contentScroll}
            contentContainerStyle={styles.contentContainer}
            showsVerticalScrollIndicator={false}
          >
            {isReply && (
              <>
                <Text style={styles.statusNote}>
                  {isDraft ? 'Gemt som udkast' : 'Sendt'}
                </Text>
                {replyTo ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>Til: </Text>
                    {replyTo}
                  </Text>
                ) : null}
                {replySubject ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>Emne: </Text>
                    {replySubject}
                  </Text>
                ) : null}
                {replyBody ? (
                  <>
                    <Text style={styles.sectionHeading}>
                      {isDraft ? 'Udkast' : 'Svar'}
                    </Text>
                    <Text style={styles.bodyReadOnly}>{replyBody}</Text>
                  </>
                ) : null}
              </>
            )}

            {isCal && (
              <>
                {calTitle ? (
                  <Text style={styles.calEventTitle}>{calTitle}</Text>
                ) : null}
                {calDateTime ? (
                  <View style={styles.calRow}>
                    <Text style={styles.calLabel}>Tid</Text>
                    <Text style={styles.calValue}>{calDateTime}</Text>
                  </View>
                ) : null}
                {calLocation ? (
                  <View style={styles.calRow}>
                    <Text style={styles.calLabel}>Sted</Text>
                    <Text style={styles.calValue}>{calLocation}</Text>
                  </View>
                ) : null}
                {calAttendees ? (
                  <View style={styles.calRow}>
                    <Text style={styles.calLabel}>Deltagere</Text>
                    <Text style={styles.calValue}>{calAttendees}</Text>
                  </View>
                ) : null}
              </>
            )}

            {type === 'nudge.push' && (
              <>
                {nudgeTitle ? (
                  <Text style={styles.calEventTitle}>{nudgeTitle}</Text>
                ) : null}
                {nudgeBody ? (
                  <>
                    <Text style={styles.sectionHeading}>Påmindelse</Text>
                    <Text style={styles.bodyReadOnly}>{nudgeBody}</Text>
                  </>
                ) : null}
              </>
            )}

            {type === 'mail.summarize' && (
              <Text style={styles.bodyReadOnly}>
                {summary || 'Handlingen er udført.'}
              </Text>
            )}

            {type === 'mail.label' && (
              <Text style={styles.bodyReadOnly}>
                {labelText
                  ? `${labelOp === 'remove' ? 'Fjernet' : 'Tilføjet'}: ${labelText}`
                  : 'Handlingen er udført.'}
              </Text>
            )}

            {/* Fallback for any other action type */}
            {!isReply &&
              !isCal &&
              type !== 'nudge.push' &&
              type !== 'mail.summarize' &&
              type !== 'mail.label' && (
                <Text style={styles.bodyReadOnly}>
                  {fallbackDetail || 'Handlingen er udført.'}
                </Text>
              )}

            {/* Original incoming message — context, shown for every type */}
            {(sourceFrom || sourceBody) ? (
              <>
                <Text style={styles.sectionHeading}>Oprindelig besked</Text>
                {sourceFrom ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>Fra: </Text>
                    {sourceFrom}
                  </Text>
                ) : null}
                {sourceBody ? (
                  <Text style={styles.sourceBodyText}>{sourceBody}</Text>
                ) : null}
              </>
            ) : null}
          </ScrollView>

          {/* Error message */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Footer — Undo when reversible, "Fortrudt" when already reverted */}
          <View style={[styles.actions, { paddingBottom: Math.max(6, chromeBottom) }]}>
            {row.reversible && !isReverted ? (
              <Pressable
                onPress={handleUndo}
                disabled={pending}
                accessibilityLabel="Fortryd"
              >
                {pending ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Text style={styles.secondary}>Fortryd</Text>
                )}
              </Pressable>
            ) : isReverted ? (
              <Text style={styles.muted}>Fortrudt</Text>
            ) : null}

            <Pressable onPress={onClose} disabled={pending} accessibilityLabel="Luk">
              <Text style={styles.secondary}>Luk</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles — mirrors ProposalDetailModal
// ---------------------------------------------------------------------------

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
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 8,
    gap: 10,
  },
  // "Sendt" / "Gemt som udkast" status note
  statusNote: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
  },
  // Reply: recipient / subject meta lines
  meta: {
    color: colors.fg3,
    fontSize: 13,
    lineHeight: 18,
  },
  metaLabel: {
    color: colors.ink,
    fontWeight: '600',
  },
  // Read-only body block
  bodyReadOnly: {
    color: colors.fg3,
    fontSize: 14,
    lineHeight: 22,
    marginTop: 4,
  },
  // Calendar detail rows
  calEventTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  calRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  calLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    width: 80,
    paddingTop: 1,
  },
  calValue: {
    color: colors.fg3,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  // Section headings — e.g. "Oprindelig besked" / "Svar"
  sectionHeading: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 2,
    opacity: 0.55,
  },
  // Read-only original message text
  sourceBodyText: {
    color: colors.fg3,
    fontSize: 13,
    lineHeight: 20,
    backgroundColor: 'rgba(11,11,12,0.04)',
    borderRadius: 8,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(11,11,12,0.08)',
  },
  // Error line above buttons
  errorText: {
    color: '#A24',
    fontSize: 12,
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  // Footer buttons
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 6,
  },
  secondary: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
  muted: {
    color: colors.fg3,
    fontSize: 13,
  },
});
