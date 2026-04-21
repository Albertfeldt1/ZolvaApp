import { Archive, ChevronDown, ChevronLeft, ChevronUp, Send } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { Stone } from '../components/Stone';
import { useAuth } from '../lib/auth';
import { useMailDetail, useSendReply } from '../lib/hooks';
import { recordMailEvent } from '../lib/mail-events';
import { runExtractor } from '../lib/profile-extractor';
import type { InboxMail } from '../lib/types';
import { colors, fonts } from '../theme';
import { translateProviderError } from '../utils/danish';

type Props = {
  mail: InboxMail;
  onClose: () => void;
};

export function InboxDetailScreen({ mail, onClose }: Props) {
  const { user } = useAuth();
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
    return ctx.provider === 'google' ? ctx.threadId : ctx.messageId;
  }

  const handleSend = async () => {
    if (!detail) return;
    const ok = await send(mail.id, draft.trim(), detail.replyContext);
    if (ok) {
      if (user?.id) {
        recordMailEvent({
          userId: user.id,
          eventType: 'drafted_reply',
          providerThreadId: replyContextThreadId(detail.replyContext),
          providerFrom: mail.from,
          providerSubject: mail.subject,
        });
        runExtractor({
          trigger: 'mail_draft',
          userId: user.id,
          text: `Brugeren besvarede en mail fra ${mail.from} om "${mail.subject}"`,
          source: `mail:${replyContextThreadId(detail.replyContext)}`,
        });
      }
      onClose();
    }
  };

  const handleArchive = async () => {
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
          text: `Brugeren ignorerede mail fra ${mail.from} med emnet "${mail.subject}"`,
          source: `mail:${detail ? replyContextThreadId(detail.replyContext) : mail.id}`,
        });
      }
      onClose();
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.topBar}>
        <Pressable
          onPress={onClose}
          style={styles.roundBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Tilbage"
        >
          <ChevronLeft size={18} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Text style={styles.topEyebrow}>Indbakke</Text>
        <View style={styles.topBarSpacer} />
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{`Mail · ${mail.time}`}</Text>
          <Text style={styles.subject}>{mail.subject}</Text>

          <View style={styles.inkRule} />

          <View style={styles.fromRow}>
            <Avatar initials={mail.initials} tone={mail.tone} />
            <View style={{ flex: 1 }}>
              <Text style={styles.fromLabel}>Fra</Text>
              <Text style={styles.fromName} numberOfLines={1}>{mail.from}</Text>
            </View>
          </View>
        </View>

        <View style={styles.bodyWrap}>
          <View style={styles.quoteRule} />
          <View style={styles.bodyContent}>
            {loading && (
              <View style={styles.bodyLoading}>
                <ActivityIndicator color={colors.fg3} />
                <Text style={styles.bodyLoadingText}>Henter mailen…</Text>
              </View>
            )}
            {error && (
              <Text style={styles.bodyError}>
                Kunne ikke hente mailen. Du kan stadig skrive et svar.
              </Text>
            )}
            {detail && (
              <Pressable
                onPress={() => {
                  if (detail.body.length > 0) setBodyExpanded((v) => !v);
                }}
                style={({ pressed }) => [pressed && detail.body.length > 0 && styles.bodyPressed]}
              >
                <Text
                  style={styles.bodyText}
                  numberOfLines={bodyExpanded ? undefined : 3}
                >
                  {detail.body || '(tom besked)'}
                </Text>
                {detail.body.length > 0 && (
                  <View style={styles.expandBtn}>
                    <Text style={styles.expandBtnText}>
                      {bodyExpanded ? 'Vis mindre' : 'Vis mere'}
                    </Text>
                    {bodyExpanded ? (
                      <ChevronUp size={13} color={colors.sageDeep} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={13} color={colors.sageDeep} strokeWidth={2} />
                    )}
                  </View>
                )}
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.replyBlock}>
          <View style={styles.replyHead}>
            <Text style={styles.replyHeading}>Dit svar</Text>
            {hasAiDraft && (
              <View style={styles.aiHint}>
                <Stone size={18} mood="thinking" />
                <Text style={styles.aiHintText}>Zolva har skrevet et udkast</Text>
              </View>
            )}
          </View>

          <View style={styles.draftCard}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder="Skriv dit svar…"
              placeholderTextColor={colors.fg3}
              style={styles.draftInput}
              textAlignVertical="top"
              editable={!sending}
            />
          </View>

          {sendError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>Kunne ikke sende — prøv igen.</Text>
              <Text style={styles.errorDetail} numberOfLines={2}>
                {translateProviderError(sendError).message}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      <View style={styles.actionBar}>
        <Pressable
          onPress={handleArchive}
          disabled={sending}
          style={({ pressed }) => [
            styles.ghostBtn,
            sending && styles.btnDisabled,
            pressed && styles.btnPressed,
          ]}
        >
          <Archive size={15} color={colors.fg2} strokeWidth={1.75} />
          <Text style={styles.ghostBtnText}>Arkivér</Text>
        </Pressable>
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.primaryBtn,
            !canSend && styles.btnDisabled,
            pressed && styles.btnPressed,
          ]}
        >
          {sending ? (
            <ActivityIndicator color={colors.paper} />
          ) : (
            <>
              <Text style={styles.primaryBtnText}>Send svar</Text>
              <Send size={15} color={colors.paper} strokeWidth={1.75} />
            </>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: Platform.OS === 'ios' ? 58 : 40,
    paddingBottom: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.paper,
  },
  roundBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topEyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  topBarSpacer: { width: 34 },

  scrollContent: { paddingBottom: 32 },

  hero: {
    backgroundColor: colors.sageSoft,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 22,
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
  subject: {
    marginTop: 10,
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.96,
    color: colors.ink,
  },
  inkRule: {
    marginTop: 18,
    height: 1,
    backgroundColor: colors.ink,
    opacity: 0.45,
  },
  fromRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fromLabel: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  fromName: {
    marginTop: 2,
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.ink,
  },

  bodyWrap: {
    flexDirection: 'row',
    paddingHorizontal: 22,
    paddingTop: 22,
  },
  quoteRule: {
    width: 2,
    backgroundColor: colors.ink,
    opacity: 0.2,
    marginRight: 14,
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 1,
  },
  bodyContent: { flex: 1 },
  bodyLoading: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 },
  bodyLoadingText: { fontFamily: fonts.ui, fontSize: 13, color: colors.fg3 },
  bodyError: {
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
    paddingVertical: 6,
  },
  bodyText: {
    fontFamily: fonts.ui,
    fontSize: 13.5,
    lineHeight: 21,
    color: colors.fg2,
  },
  bodyPressed: { opacity: 0.65 },
  expandBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.sageSoft,
  },
  expandBtnText: {
    fontFamily: fonts.monoSemi,
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },

  replyBlock: {
    marginTop: 28,
    paddingHorizontal: 22,
  },
  replyHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    gap: 10,
  },
  replyHeading: {
    fontFamily: fonts.displayItalic,
    fontSize: 24,
    lineHeight: 28,
    letterSpacing: -0.48,
    color: colors.ink,
  },
  aiHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: colors.mist,
  },
  aiHintText: {
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 11.5,
    color: colors.fg2,
  },
  draftCard: {
    backgroundColor: colors.paperDeep,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 4,
  },
  draftInput: {
    fontFamily: fonts.ui,
    fontSize: 14.5,
    lineHeight: 22,
    color: colors.ink,
    padding: 14,
    minHeight: 150,
  },

  errorBanner: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.warningSoft,
    gap: 4,
  },
  errorText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12.5,
    color: colors.warningInk,
  },
  errorDetail: {
    fontFamily: fonts.mono,
    fontSize: 10.5,
    color: colors.warningInk,
    opacity: 0.75,
  },

  actionBar: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
    backgroundColor: colors.paper,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: 'transparent',
  },
  ghostBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    color: colors.fg2,
  },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: colors.sage,
    shadowColor: colors.sageDeep,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 4,
  },
  primaryBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    letterSpacing: -0.1,
    color: colors.paper,
  },
  btnDisabled: { opacity: 0.4, shadowOpacity: 0 },
  btnPressed: { opacity: 0.82 },
});
