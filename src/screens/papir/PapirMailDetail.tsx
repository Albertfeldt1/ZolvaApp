import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { Check, Paperclip, Send, Sparkles } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { getGmailSignature } from '../../lib/gmail';
import { useGenerateDraftAction, useMailDetail, useSendReply } from '../../lib/hooks';
import { openMailAttachment } from '../../lib/mail-attachments';
import { loadSignature, renderImported, renderSignature, subscribeSignature } from '../../lib/mail-signature';
import { recordMailEvent } from '../../lib/mail-events';
import { runExtractor } from '../../lib/profile-extractor';
import type { MailAttachment, MailProvider, ReplyContext } from '../../lib/types';
import { usePapirNav, type PushParams } from './nav';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';

/** Plain-text preview of the signature the send path will append - the
 * append itself is invisible in the editor, which read as "my signature is
 * missing". Gmail replies get the server-side sendAs signature (see
 * appendGmailSignature); Outlook/iCloud get the local one via
 * buildOutgoingBody. Mirrors that branching so the preview is truthful. */
function useSignaturePreview(provider: MailProvider | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (provider === 'google') {
          const sig = await getGmailSignature();
          if (!cancelled) setText(sig);
          return;
        }
        const data = await loadSignature();
        if (cancelled) return;
        if (!data) {
          setText(null);
          return;
        }
        const rendered = data.kind === 'imported' ? renderImported(data) : renderSignature(data);
        setText(rendered?.plaintext?.trim() || null);
      } catch {
        if (!cancelled) setText(null);
      }
    };
    void load();
    const unsub = provider === 'google' ? null : subscribeSignature(() => void load());
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [provider]);
  return text;
}

function replyContextThreadId(ctx: ReplyContext): string {
  if (ctx.provider === 'google') return ctx.threadId;
  if (ctx.provider === 'microsoft') return ctx.messageId;
  return `icloud:${ctx.uid}`;
}

function sizeLabel(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Vedhæftningsrækker (M12): metadata vises straks; bytes hentes først ved
 * tryk og løftes i iOS-delearket, så filen kan gemmes/åbnes i anden app. */
function AttachmentRows({
  provider,
  messageId,
  attachments,
}: {
  provider: MailProvider;
  messageId: string;
  attachments: MailAttachment[];
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (attachments.length === 0) return null;
  const open = async (att: MailAttachment) => {
    if (busyId) return;
    setBusyId(att.id);
    try {
      await openMailAttachment(provider, messageId, att);
    } catch (e) {
      console.warn('[mail] attachment open failed:', e instanceof Error ? e.message : String(e));
      Alert.alert('Vedhæftning', 'Vedhæftningen kunne ikke hentes. Prøv igen.');
    } finally {
      setBusyId(null);
    }
  };
  return (
    <View style={{ paddingHorizontal: papirSpace.screen, marginTop: 18, gap: 8 }}>
      <PaperText role="eyebrow" color={papirColor.ink3}>
        Vedhæftninger
      </PaperText>
      {attachments.map((att) => (
        <ScaleButton
          key={att.id}
          scaleTo={0.98}
          haptic="light"
          onPress={() => void open(att)}
          accessibilityRole="button"
          accessibilityLabel={`Åbn vedhæftning ${att.name}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            borderWidth: 1,
            borderColor: papirColor.line,
            borderRadius: papirRadius.lg,
            backgroundColor: papirColor.card,
            paddingVertical: 10,
            paddingHorizontal: 12,
            opacity: busyId && busyId !== att.id ? 0.5 : 1,
          }}
        >
          <Paperclip size={15} color={papirColor.ink3} strokeWidth={1.8} />
          <PaperText role="small" style={{ flex: 1 }} numberOfLines={1}>
            {att.name}
          </PaperText>
          <PaperText role="caption" color={papirColor.ink4} tabular>
            {busyId === att.id ? 'Henter…' : sizeLabel(att.sizeBytes)}
          </PaperText>
        </ScaleButton>
      ))}
    </View>
  );
}

/** Papir mail detail: body + reply editor. Reply/draft/archive behavior is
 * 1:1 with the classic InboxDetailScreen (same hooks, same event recording,
 * same draft-at-risk guard) — only the chrome is Papir. */
export function PapirMailDetail({ params }: { params: PushParams }) {
  const nav = usePapirNav();
  const { user } = useAuth();
  const id = params.id ?? null;
  const provider = (params.provider ?? null) as MailProvider | null;
  const { data: detail, loading } = useMailDetail(id, provider);
  const signaturePreview = useSignaturePreview(provider);
  const { send, archive, sending } = useSendReply();
  const { generate, loading: generating } = useGenerateDraftAction();
  const [draft, setDraft] = useState(params.aiDraft ?? '');
  const [bodyExpanded, setBodyExpanded] = useState(false);
  // Gates the confirm dialog itself: `sending` flips asynchronously, so two
  // fast taps could stack two alerts (M11).
  const confirmingRef = useRef(false);

  const from = detail?.from || params.from || 'Ukendt afsender';
  const subject = detail?.subject || params.subject || 'Uden emne';

  const handleSend = () => {
    if (!detail || !draft.trim() || sending || confirmingRef.current) return;
    confirmingRef.current = true;
    Alert.alert('Send svar?', `Til ${from}`, [
      { text: 'Annullér', style: 'cancel', onPress: () => { confirmingRef.current = false; } },
      {
        text: 'Send',
        onPress: async () => {
          confirmingRef.current = false;
          const ok = await send(detail.id, draft.trim(), detail.replyContext);
          if (!ok) {
            Alert.alert('Send', 'Svaret kunne ikke sendes. Tjek din forbindelse og prøv igen.');
            return;
          }
          if (user?.id) {
            recordMailEvent({
              userId: user.id,
              eventType: 'replied',
              providerThreadId: replyContextThreadId(detail.replyContext),
              providerFrom: from,
              providerTo: from,
              providerSubject: subject,
            });
            runExtractor({
              trigger: 'mail_draft',
              userId: user.id,
              text: `Du besvarede en mail fra ${from} om "${subject}"`,
              source: `mail:${replyContextThreadId(detail.replyContext)}`,
            });
          }
          nav.back();
        },
      },
    ]);
  };

  const performArchive = async () => {
    if (!id || !provider) return;
    const ok = await archive(id, provider);
    if (!ok) {
      Alert.alert('Håndteret', 'Mailen kunne ikke markeres som håndteret. Prøv igen.');
      return;
    }
    if (user?.id) {
      recordMailEvent({
        userId: user.id,
        eventType: 'dismissed',
        providerThreadId: detail ? replyContextThreadId(detail.replyContext) : id,
        providerFrom: from,
        providerTo: user.email ?? '',
        providerSubject: subject,
      });
    }
    nav.back();
  };

  const handleArchive = () => {
    // Only nag when there's actually a draft at risk (classic H28 fix).
    if (draft.trim().length === 0) {
      void performArchive();
      return;
    }
    Alert.alert('Markér som håndteret?', 'Dit svar bliver ikke sendt eller gemt.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Håndtér', style: 'destructive', onPress: () => void performArchive() },
    ]);
  };

  // Back with an unsent draft → same guard as archive (don't silently lose it).
  const draftDirty = draft.trim().length > 0 && draft.trim() !== (params.aiDraft ?? '').trim();
  const handleBack = () => {
    if (!draftDirty) {
      nav.back();
      return;
    }
    Alert.alert('Forlad udkast?', 'Dit svar bliver ikke sendt eller gemt.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Forlad', style: 'destructive', onPress: () => nav.back() },
    ]);
  };

  // Android hardware back must hit the same guard as the header button —
  // without this the shell pops the stack directly and the draft dies
  // silently (H6).
  const draftDirtyRef = useRef(draftDirty);
  draftDirtyRef.current = draftDirty;
  useEffect(() => {
    nav.setBackGuard(() => {
      if (!draftDirtyRef.current) return false; // let the shell pop normally
      Alert.alert('Forlad udkast?', 'Dit svar bliver ikke sendt eller gemt.', [
        { text: 'Annullér', style: 'cancel' },
        { text: 'Forlad', style: 'destructive', onPress: () => nav.back() },
      ]);
      return true;
    });
    return () => nav.setBackGuard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleGenerate = async () => {
    if (!detail || generating) return;
    const text = await generate({ from, subject, body: detail.body });
    if (text) setDraft(text);
    else Alert.alert('Udkast', 'Udkastet kunne ikke genereres. Prøv igen.');
  };

  const bodyPreview = detail?.body ?? '';
  const bodyIsLong = bodyPreview.length > 600;
  const shownBody = bodyExpanded || !bodyIsLong ? bodyPreview : `${bodyPreview.slice(0, 600)}…`;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
          <PushHeader title="Mail" onBack={handleBack} />

          <View style={{ paddingHorizontal: papirSpace.screen }}>
            <PaperText role="caption" color={papirColor.ink3}>
              {from}
              {params.time ? ` · ${params.time}` : ''}
            </PaperText>
            <PaperText role="displayS" style={{ marginTop: 8 }}>
              {subject}
            </PaperText>
          </View>

          {loading && !detail ? (
            <View style={{ alignItems: 'center', paddingTop: 50 }}>
              <PapirLoader />
            </View>
          ) : (
            <View style={{ paddingHorizontal: papirSpace.screen, marginTop: 18 }}>
              <PaperText role="body" color={papirColor.ink2}>
                {shownBody || 'Mailen kunne ikke hentes.'}
              </PaperText>
              {bodyIsLong ? (
                <ScaleButton scaleTo={0.98} haptic="light" onPress={() => setBodyExpanded((e) => !e)} style={{ paddingVertical: 10 }}>
                  <PaperText role="small" color={papirColor.red}>
                    {bodyExpanded ? 'Vis mindre' : 'Vis hele mailen'}
                  </PaperText>
                </ScaleButton>
              ) : null}
            </View>
          )}

          {detail && provider ? (
            <AttachmentRows provider={provider} messageId={detail.id} attachments={detail.attachments ?? []} />
          ) : null}

          {/* Reply editor */}
          <View
            style={{
              marginHorizontal: papirSpace.screen,
              marginTop: 24,
              borderWidth: 1,
              borderColor: papirColor.line,
              borderRadius: papirRadius.xl,
              backgroundColor: papirColor.card,
              padding: 14,
            }}
          >
            <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginBottom: 8 }}>
              Dit svar
            </PaperText>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Skriv et svar…"
              placeholderTextColor={papirColor.ink4}
              selectionColor={papirColor.red}
              multiline
              style={{
                minHeight: 90,
                fontSize: 15,
                color: papirColor.ink,
                textAlignVertical: 'top',
                paddingTop: 0,
              }}
              accessibilityLabel="Svar-tekst"
            />
            {draft.trim().length === 0 ? (
              <Button
                label={generating ? 'Skriver udkast…' : 'Generér udkast'}
                variant="ghost"
                left={<Sparkles size={15} color={papirColor.ink} strokeWidth={1.8} />}
                onPress={handleGenerate}
                disabled={generating || !detail}
              />
            ) : null}
            {signaturePreview ? (
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: papirColor.lineSoft,
                  marginTop: 12,
                  paddingTop: 10,
                }}
              >
                <PaperText role="small" color={papirColor.ink3}>
                  {signaturePreview}
                </PaperText>
                <PaperText role="caption" color={papirColor.ink4} style={{ marginTop: 5 }}>
                  Din signatur — tilføjes automatisk når du sender
                </PaperText>
              </View>
            ) : null}
          </View>
        </ScrollView>

        {/* Action bar */}
        <View
          style={{
            flexDirection: 'row',
            gap: 12,
            paddingHorizontal: papirSpace.screen,
            paddingTop: 10,
            paddingBottom: 26,
            backgroundColor: papirColor.paper,
          }}
        >
          <Button
            label="Håndteret"
            variant="ghost"
            left={<Check size={15} color={papirColor.ink} strokeWidth={1.8} />}
            style={{ paddingHorizontal: 20 }}
            onPress={handleArchive}
            disabled={sending}
          />
          <Button
            label={sending ? 'Sender…' : 'Send svar'}
            variant="primary"
            left={<Send size={15} color="#FFFFFF" strokeWidth={1.8} />}
            style={{ flex: 1 }}
            onPress={handleSend}
            disabled={sending || !detail || draft.trim().length === 0}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
