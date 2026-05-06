import { Archive, ChevronDown, ChevronLeft, ChevronUp, Send } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Avatar } from '../components/Avatar';
import { useTheme } from '../design/useTheme';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useAuth } from '../lib/auth';
import { useMailDetail, useSendReply } from '../lib/hooks';
import { recordMailEvent } from '../lib/mail-events';
import { runExtractor } from '../lib/profile-extractor';
import type { InboxMail } from '../lib/types';
import { translateProviderError } from '../utils/danish';

type Props = {
  mail: InboxMail;
  onClose: () => void;
};

export function InboxDetailScreen({ mail, onClose }: Props) {
  const { user } = useAuth();
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { data: detail, loading, error } = useMailDetail(mail.id, mail.provider);
  const { send, archive, sending, error: sendError } = useSendReply();
  const [draft, setDraft] = useState(mail.aiDraft ?? '');
  const [bodyExpanded, setBodyExpanded] = useState(false);

  useEffect(() => {
    if (mail.aiDraft && !draft) setDraft(mail.aiDraft);
  }, [mail.aiDraft, draft]);

  const canSend = draft.trim().length > 0 && !!detail && !sending;
  const hasAiDraft = !!mail.aiDraft;

  function replyContextThreadId(ctx: import('../lib/types').ReplyContext): string {
    if (ctx.provider === 'google') return ctx.threadId;
    if (ctx.provider === 'microsoft') return ctx.messageId;
    return `icloud:${ctx.uid}`;
  }

  const handleSend = async () => {
    if (!detail) return;
    const ok = await send(mail.id, draft.trim(), detail.replyContext);
    if (ok) {
      if (user?.id) {
        recordMailEvent({
          userId: user.id,
          eventType: 'replied',
          providerThreadId: replyContextThreadId(detail.replyContext),
          providerFrom: mail.from,
          providerSubject: mail.subject,
        });
        runExtractor({
          trigger: 'mail_draft',
          userId: user.id,
          text: `Du besvarede en mail fra ${mail.from} om "${mail.subject}"`,
          source: `mail:${replyContextThreadId(detail.replyContext)}`,
        });
      }
      onClose();
    }
  };

  const performArchive = async () => {
    const ok = await archive(mail.id, mail.provider);
    if (ok) {
      if (user?.id) {
        recordMailEvent({
          userId: user.id,
          eventType: 'dismissed',
          providerThreadId: detail ? replyContextThreadId(detail.replyContext) : mail.id,
          providerFrom: mail.from,
          providerSubject: mail.subject,
        });
        runExtractor({
          trigger: 'mail_decision',
          userId: user.id,
          text: `Du ignorerede mail fra ${mail.from} med emnet "${mail.subject}"`,
          source: `mail:${detail ? replyContextThreadId(detail.replyContext) : mail.id}`,
        });
      }
      onClose();
    }
  };

  const handleArchive = () => {
    // Only nag when there's actually a draft at risk. Empty textarea → archive
    // straight through. Any non-whitespace content → confirm, because the draft
    // is neither sent nor persisted anywhere the user can recover it.
    if (draft.trim().length === 0) {
      void performArchive();
      return;
    }
    Alert.alert(
      'Arkivér udkast?',
      'Dit svar bliver ikke sendt eller gemt.',
      [
        { text: 'Annullér', style: 'cancel' },
        { text: 'Arkivér', style: 'destructive', onPress: () => void performArchive() },
      ],
      { cancelable: true },
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />

        {/* Header — glass card with back button + eyebrow */}
        <View
          style={{
            paddingTop: spacing.statusBarFallback,
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.cardPad,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Pressable
                onPress={onClose}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Tilbage"
              >
                <ChevronLeft size={18} color={t.ink} strokeWidth={1.75} />
              </Pressable>
              <Text
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: 0.88,
                  textTransform: 'uppercase',
                  color: t.ink3,
                }}
              >
                Indbakke
              </Text>
            </View>
          </GlassFrostedCard>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero — bone glass card: eyebrow + subject + sender */}
          <View style={{ paddingHorizontal: spacing.screenPad, paddingBottom: spacing.cardPad }}>
            <GlassFrostedCard
              overlay={surface.bone}
              radius={radius.card}
              style={{ padding: spacing.lg }}
            >
              <Text
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  letterSpacing: 0.88,
                  textTransform: 'uppercase',
                  color: t.ink3,
                }}
              >
                {`Mail · ${mail.time}`}
              </Text>

              <Text
                style={{
                  marginTop: 10,
                  fontFamily: fonts.display,
                  fontSize: 30,
                  lineHeight: 36,
                  letterSpacing: -0.9,
                  color: t.ink,
                }}
              >
                {mail.subject}
              </Text>

              <View
                style={{
                  marginTop: 18,
                  height: 1,
                  backgroundColor: t.ink,
                  opacity: 0.45,
                }}
              />

              <View
                style={{
                  marginTop: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Avatar initials={mail.initials} tone={mail.tone} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10.5,
                      letterSpacing: 0.88,
                      textTransform: 'uppercase',
                      color: t.ink3,
                    }}
                  >
                    Fra
                  </Text>
                  <Text
                    style={{
                      marginTop: 2,
                      fontFamily: fonts.uiBold,
                      fontSize: 14,
                      color: t.ink,
                    }}
                    numberOfLines={1}
                  >
                    {mail.from}
                  </Text>
                </View>
              </View>
            </GlassFrostedCard>
          </View>

          {/* Mail body — bone glass card with quote accent */}
          <View style={{ paddingHorizontal: spacing.screenPad, paddingBottom: spacing.cardPad }}>
            <GlassFrostedCard overlay={surface.bone} radius={radius.card} style={{ padding: spacing.lg }}>
              <View style={{ flexDirection: 'row' }}>
                {/* Vertical quote rule */}
                <View
                  style={{
                    width: 2,
                    backgroundColor: t.ink,
                    opacity: 0.2,
                    marginRight: 14,
                    marginTop: 4,
                    marginBottom: 4,
                    borderRadius: 1,
                  }}
                />
                <View style={{ flex: 1 }}>
                  {loading && (
                    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 }}>
                      <ActivityIndicator color={t.ink3} />
                      <Text style={{ fontFamily: fonts.ui, fontSize: 13, color: t.ink3 }}>
                        Henter mailen…
                      </Text>
                    </View>
                  )}
                  {error && (
                    <Text
                      style={{
                        fontFamily: fonts.ui,
                        fontSize: 13,
                        color: t.ink3,
                        paddingVertical: 6,
                        fontStyle: 'italic',
                      }}
                    >
                      Kunne ikke hente mailen. Du kan stadig skrive et svar.
                    </Text>
                  )}
                  {detail && (
                    <Pressable
                      onPress={() => {
                        if (detail.body.length > 0) setBodyExpanded((v) => !v);
                      }}
                      style={({ pressed }) => [
                        pressed && detail.body.length > 0 && { opacity: 0.65 },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: fonts.ui,
                          fontSize: 13.5,
                          lineHeight: 21,
                          color: t.ink2,
                        }}
                        numberOfLines={bodyExpanded ? undefined : 3}
                      >
                        {detail.body || '(tom besked)'}
                      </Text>
                      {detail.body.length > 0 && (
                        <View
                          style={{
                            marginTop: 10,
                            flexDirection: 'row',
                            alignItems: 'center',
                            alignSelf: 'flex-start',
                            gap: 5,
                            paddingHorizontal: 10,
                            paddingVertical: 5,
                            borderRadius: radius.pill,
                            backgroundColor: surface.scrim,
                          }}
                        >
                          <Text
                            style={{
                              fontFamily: fonts.mono,
                              fontSize: 10.5,
                              letterSpacing: 0.6,
                              textTransform: 'uppercase',
                              color: t.ink3,
                            }}
                          >
                            {bodyExpanded ? 'Vis mindre' : 'Vis mere'}
                          </Text>
                          {bodyExpanded ? (
                            <ChevronUp size={13} color={t.ink3} strokeWidth={2} />
                          ) : (
                            <ChevronDown size={13} color={t.ink3} strokeWidth={2} />
                          )}
                        </View>
                      )}
                    </Pressable>
                  )}
                </View>
              </View>
            </GlassFrostedCard>
          </View>

          {/* Reply / AI draft section — bone glass card + chat-style input dock */}
          <View style={{ paddingHorizontal: spacing.screenPad }}>
            {/* Section header */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
                gap: 10,
                paddingHorizontal: spacing.xs,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.display,
                  fontStyle: 'italic',
                  fontSize: 24,
                  lineHeight: 28,
                  letterSpacing: -0.48,
                  color: t.ink,
                }}
              >
                Dit svar
              </Text>
              {hasAiDraft && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: radius.pill,
                    backgroundColor: surface.scrim,
                  }}
                >
                  <Stone size={18} jumpOnTap={false} />
                  <Text
                    style={{
                      fontFamily: fonts.ui,
                      fontSize: 11.5,
                      color: t.ink2,
                      fontStyle: 'italic',
                    }}
                  >
                    Zolva har skrevet et udkast
                  </Text>
                </View>
              )}
            </View>

            {/* Draft input — glass pill, white fill + hairline border (Chat input dock pattern) */}
            <GlassFrostedCard radius={radius.card} style={{ padding: spacing.sm }}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                multiline
                placeholder="Skriv dit svar…"
                placeholderTextColor={t.ink4}
                style={{
                  fontFamily: fonts.ui,
                  fontSize: 14.5,
                  lineHeight: 22,
                  color: t.ink,
                  padding: 14,
                  minHeight: 150,
                  backgroundColor: '#FFFFFF',
                  borderRadius: radius.card - 4,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.line,
                  textAlignVertical: 'top',
                }}
                editable={!sending}
              />
            </GlassFrostedCard>

            {/* Send error banner */}
            {sendError && (
              <View style={{ marginTop: 12 }}>
                <GlassFrostedCard
                  overlay={surface.warningTint}
                  radius={radius.card}
                  style={{ padding: spacing.cardPad, gap: 4 }}
                >
                  <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                    Kunne ikke sende — prøv igen.
                  </Text>
                  <Text
                    style={{ fontFamily: fonts.mono, fontSize: 10.5, color: t.ink2, opacity: 0.75 }}
                    numberOfLines={2}
                  >
                    {translateProviderError(sendError).message}
                  </Text>
                </GlassFrostedCard>
              </View>
            )}
          </View>
        </ScrollView>

        {/* Action bar — archive ghost + send dark-ink pill */}
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            alignItems: 'center',
            paddingHorizontal: spacing.screenPad,
            paddingTop: 12,
            paddingBottom: Platform.OS === 'ios' ? 28 : 16,
            backgroundColor: t.paper,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.line,
          }}
        >
          <Pressable
            onPress={handleArchive}
            disabled={sending}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingHorizontal: 18,
                paddingVertical: 14,
                borderRadius: radius.pill,
              },
              sending && { opacity: 0.4 },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Archive size={15} color={t.ink2} strokeWidth={1.75} />
            <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: t.ink2 }}>Arkivér</Text>
          </Pressable>

          {/* Dark-ink send pill */}
          <Pressable
            onPress={handleSend}
            disabled={!canSend}
            style={({ pressed }) => [
              {
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                paddingHorizontal: 18,
                paddingVertical: 14,
                borderRadius: radius.pill,
                backgroundColor: t.ink,
              },
              !canSend && { opacity: 0.4 },
              pressed && { opacity: 0.82 },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Text
                  style={{
                    fontFamily: fonts.uiBold,
                    fontSize: 14.5,
                    letterSpacing: -0.1,
                    color: '#FFFFFF',
                  }}
                >
                  Send svar
                </Text>
                <Send size={15} color="#FFFFFF" strokeWidth={1.75} />
              </>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
