/**
 * ProposalDetailModal — full-screen Animated.View overlay (NOT a native
 * <Modal>) for reviewing a pending agent proposal before approving or
 * dismissing it.
 *
 * Overlay pattern: matches MemoryConsentModal / CalendarPickerSheet —
 * absolute-fill Animated.View with fade-in, mounted outside the
 * ScrollView in TodayScreen so it is never clipped.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import {
  approveProposedAction,
  dismissProposedAction,
  type ProposedActionRow,
} from '../lib/agent-proposals';
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
  row: ProposedActionRow;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProposalDetailModal({ row, onClose }: Props) {
  const { surface, shadows } = useTheme();
  const { bottom: chromeBottom } = useChromeInsets();

  const isReply = REPLY_TYPES.has(row.action_type);
  const isCal = CAL_TYPES.has(row.action_type);

  // For replies: prefer payload.body_full (full text) over the short preview.
  // Only allow editing when body_full is present — editing a truncated preview
  // would send a truncated reply, which is worse than sending the original.
  const bodyFull = str(row.payload.body_full);
  const hasFullBody = isReply && bodyFull.length > 0;
  const bodyForDisplay = hasFullBody ? bodyFull : str(row.preview.body);

  const [editedText, setEditedText] = useState(bodyForDisplay);
  const [pending, setPending] = useState<'approve' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleApprove() {
    setPending('approve');
    setError(null);
    // Only splice the edited body when we have the full text AND it's a reply.
    const editedBody = hasFullBody ? editedText : undefined;
    const r = await approveProposedAction(row.id, editedBody);
    setPending(null);
    if (r.ok) {
      onClose();
    } else {
      setError(r.error ?? 'Ukendt fejl');
    }
  }

  async function handleDismiss() {
    setPending('dismiss');
    setError(null);
    const r = await dismissProposedAction(row.id);
    setPending(null);
    if (r.ok) {
      onClose();
    } else {
      setError(r.error ?? 'Kunne ikke springe over');
    }
  }

  // -------------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------------

  const modalTitle =
    str(row.preview.title) ||
    (isReply ? 'Svar' : isCal ? 'Begivenhed' : 'Forslag');

  const approveLabel = isReply ? 'Send' : 'Godkend';

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

  // Sender (present in both reply and calendar proposals)
  const sourceFrom = str(row.payload.source_from);

  // Original incoming message body — shown read-only so the user has full context
  const sourceBody = str(row.payload.source_body);

  // Reply fields
  const replyTo = str(row.payload.to);
  const replySubject = str(row.payload.subject);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Animated.View
      style={styles.overlay}
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(240)}
    >
      {/* Dimmed backdrop — tap outside sheet to close */}
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Luk" />

      <View style={styles.safeArea} pointerEvents="box-none">
        <Animated.View
          entering={SlideInDown.duration(260)}
          exiting={SlideOutDown.duration(220)}
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
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {isReply && (
              <>
                {sourceFrom ? (
                  <Text style={styles.meta}>
                    <Text style={styles.metaLabel}>Fra: </Text>
                    {sourceFrom}
                  </Text>
                ) : null}
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

                {sourceBody ? (
                  <>
                    <Text style={styles.sectionHeading}>Original besked</Text>
                    <Text style={styles.sourceBodyText}>{sourceBody}</Text>
                  </>
                ) : null}

                {(hasFullBody || bodyForDisplay.length > 0) ? (
                  <Text style={styles.sectionHeading}>Dit svar</Text>
                ) : null}

                {hasFullBody ? (
                  <TextInput
                    value={editedText}
                    onChangeText={setEditedText}
                    multiline
                    style={styles.editInput}
                    accessibilityLabel="Redigér svar"
                    textAlignVertical="top"
                  />
                ) : (
                  <>
                    <Text style={styles.bodyReadOnly}>{bodyForDisplay}</Text>
                    {bodyForDisplay.length === 0 ? null : (
                      <Text style={styles.noEditHint}>
                        Forhåndsvisning — åbn mailen for at redigere.
                      </Text>
                    )}
                  </>
                )}
              </>
            )}

            {isCal && (
              <>
                {calTitle ? (
                  <Text style={styles.calEventTitle}>{calTitle}</Text>
                ) : null}
                {sourceFrom ? (
                  <View style={styles.calRow}>
                    <Text style={styles.calLabel}>Fra</Text>
                    <Text style={styles.calValue}>{sourceFrom}</Text>
                  </View>
                ) : null}
                {calDateTime ? (
                  <View style={styles.calRow}>
                    <Text style={styles.calLabel}>Tidspunkt</Text>
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
                {sourceBody ? (
                  <>
                    <Text style={styles.sectionHeading}>Original besked</Text>
                    <Text style={styles.sourceBodyText}>{sourceBody}</Text>
                  </>
                ) : null}
              </>
            )}

            {!isReply && !isCal && (
              <Text style={styles.bodyReadOnly}>{str(row.preview.body)}</Text>
            )}
          </ScrollView>

          {/* Error message */}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Action buttons — chromeBottom clears the floating tab bar */}
          <View style={[styles.actions, { paddingBottom: Math.max(6, chromeBottom) }]}>
            <Pressable
              onPress={handleApprove}
              disabled={!!pending}
              style={styles.primary}
              accessibilityLabel={approveLabel}
            >
              {pending === 'approve' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryText}>{approveLabel}</Text>
              )}
            </Pressable>

            <Pressable
              onPress={handleDismiss}
              disabled={!!pending}
              accessibilityLabel="Spring over"
            >
              {pending === 'dismiss' ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text style={styles.secondary}>Spring over</Text>
              )}
            </Pressable>

            <Pressable onPress={onClose} disabled={!!pending} accessibilityLabel="Luk">
              <Text style={styles.secondary}>Luk</Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const ABSOLUTE_FILL = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

const styles = StyleSheet.create({
  // Full-screen Animated.View — mounted outside the ScrollView in TodayScreen
  // so it is never clipped. zIndex 1000 sits above the tab bar (z 999).
  overlay: {
    ...ABSOLUTE_FILL,
    zIndex: 1000,
    justifyContent: 'flex-end',
  },
  // Semi-transparent backdrop — absorbs taps that miss the sheet
  backdrop: {
    ...ABSOLUTE_FILL,
    backgroundColor: 'rgba(11,11,12,0.45)',
  },
  safeArea: {
    // Fill the overlay so the sheet's percentage maxHeight resolves against a
    // definite (full-screen) height. Without this the parent is content-sized,
    // the cap can't resolve, and the flexShrink ScrollView mis-sizes — opening
    // pre-scrolled even when short content would fit with no scroll at all.
    flex: 1,
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
  // Editable body when body_full is present
  editInput: {
    color: colors.ink,
    fontSize: 14,
    lineHeight: 22,
    minHeight: 120,
    padding: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(11,11,12,0.12)',
    marginTop: 4,
    textAlignVertical: 'top',
  },
  // Read-only body when only the short preview is available
  bodyReadOnly: {
    color: colors.fg3,
    fontSize: 14,
    lineHeight: 22,
    marginTop: 4,
  },
  noEditHint: {
    color: colors.fg3,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 6,
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
  // Section headings — e.g. "Original besked" / "Dit svar"
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
  // Action buttons — matches ProposedActionCard button styles
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 6,
  },
  primary: {
    backgroundColor: colors.ink,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    minWidth: 64,
    alignItems: 'center',
  },
  primaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondary: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
});
