import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { ArrowUp, Trash2 } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Chip, IconButton, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useChat, useChatSuggestions } from '../../lib/hooks';
import type { ChatMessage, SendDraftAction } from '../../lib/types';
import { PushHeader } from './PushHeader';

function ZolvaMsg({ text }: { text: string }) {
  return (
    <View style={{ maxWidth: '84%', alignSelf: 'flex-start' }}>
      <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginBottom: 6 }}>
        Zolva
      </PaperText>
      <PaperText role="body">{text}</PaperText>
    </View>
  );
}

function MeMsg({ text }: { text: string }) {
  return (
    <View
      style={{
        maxWidth: '84%',
        alignSelf: 'flex-end',
        backgroundColor: papirColor.ink,
        paddingVertical: 12,
        paddingHorizontal: 15,
        borderRadius: 18,
        borderBottomRightRadius: 5,
      }}
    >
      <PaperText role="body" color={papirColor.onInk}>
        {text}
      </PaperText>
    </View>
  );
}

type DraftState = 'idle' | 'sending' | 'sent' | 'failed';

function DraftCard({ draft, onSend }: { draft: SendDraftAction; onSend: () => Promise<boolean> }) {
  const [state, setState] = useState<DraftState>('idle');
  const run = async () => {
    if (state === 'sending' || state === 'sent') return;
    setState('sending');
    const ok = await onSend();
    setState(ok ? 'sent' : 'failed');
    if (!ok) Alert.alert('Send', 'Udkastet kunne ikke sendes. Prøv igen.');
  };
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        width: '84%',
        borderWidth: 1,
        borderColor: papirColor.line,
        borderRadius: 16,
        padding: 13,
        backgroundColor: papirColor.card,
      }}
    >
      <PaperText role="bodyStrong">{draft.subject || draft.label}</PaperText>
      <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 3 }} numberOfLines={2}>
        Til {draft.to.join(', ')}
      </PaperText>
      <PaperText role="caption" color={papirColor.ink2} style={{ marginTop: 6 }} numberOfLines={3}>
        {draft.body}
      </PaperText>
      <ScaleButton
        scaleTo={0.95}
        haptic="light"
        onPress={run}
        disabled={state === 'sending' || state === 'sent'}
        style={{
          alignSelf: 'flex-start',
          marginTop: 11,
          backgroundColor: state === 'sent' ? papirColor.green : papirColor.red,
          paddingVertical: 8,
          paddingHorizontal: 16,
          borderRadius: papirRadius.pill,
          minWidth: 86,
          alignItems: 'center',
        }}
      >
        {state === 'sending' ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <PaperText role="small" color="#FFFFFF">
            {state === 'sent' ? 'Sendt ✓' : state === 'failed' ? 'Prøv igen' : 'Send svar'}
          </PaperText>
        )}
      </ScaleButton>
    </View>
  );
}

function capResetLabel(resetsAt: string | null): string {
  if (!resetsAt) return 'senere';
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return 'senere';
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PapirChat() {
  const chat = useChat();
  const suggestions = useChatSuggestions();
  const [input, setInput] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const countRef = useRef(0);

  // The quota banner must not outlive the quota: auto-clear when resetsAt
  // passes so the composer unblocks without a restart (M10).
  useEffect(() => {
    if (!chat.chatCap?.resetsAt) return;
    const check = () => {
      const t = new Date(chat.chatCap?.resetsAt ?? '').getTime();
      if (!Number.isNaN(t) && t <= Date.now()) chat.clearChatCap();
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.chatCap?.resetsAt]);

  // Auto-scroll only when new content arrives (not on every keystroke).
  useEffect(() => {
    if (chat.data.length !== countRef.current) {
      countRef.current = chat.data.length;
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    }
  }, [chat.data.length, chat.typing]);

  const sendText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chat.typing) return;
    setInput('');
    chat.send(trimmed);
  };

  const confirmClear = () => {
    if (chat.data.length === 0) return;
    Alert.alert('Ryd samtalen?', 'Historikken slettes fra denne enhed.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Ryd', style: 'destructive', onPress: chat.clear },
    ]);
  };

  const renderMessage = (m: ChatMessage) => {
    const bubble = m.from === 'user' ? <MeMsg text={m.text} /> : <ZolvaMsg text={m.text} />;
    const drafts = m.drafts ?? [];
    if (drafts.length === 0) return <View key={m.id}>{bubble}</View>;
    return (
      <View key={m.id} style={{ gap: 12 }}>
        {bubble}
        {drafts.map((d, i) => (
          <DraftCard key={`${m.id}-draft-${i}`} draft={d} onSend={() => chat.sendDraft(d).then((r) => r.ok)} />
        ))}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <PushHeader
          title="Zolva"
          right={
            <IconButton accessibilityLabel="Ryd samtalen" onPress={confirmClear}>
              <Trash2 size={16} color={papirColor.ink3} strokeWidth={1.8} />
            </IconButton>
          }
        />
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: papirSpace.screen, paddingTop: 6, paddingBottom: 12, gap: 16 }}
          showsVerticalScrollIndicator={false}
        >
          {chat.data.length === 0 ? (
            <View style={{ alignItems: 'center', paddingTop: 60, gap: 8 }}>
              <PaperText role="bodyStrong" color={papirColor.ink2}>
                Spørg om hvad som helst
              </PaperText>
              <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 260 }}>
                Zolva kender din kalender, dine mails og dine noter.
              </PaperText>
            </View>
          ) : (
            chat.data.map(renderMessage)
          )}
          {chat.typing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' }}>
              <ActivityIndicator size="small" color={papirColor.ink3} />
              <PaperText role="caption" color={papirColor.ink3}>
                Zolva tænker…
              </PaperText>
            </View>
          ) : null}
        </ScrollView>

        {/* Quota banner */}
        {chat.chatCap ? (
          <View
            style={{
              marginHorizontal: papirSpace.screen,
              marginBottom: 8,
              padding: 12,
              borderRadius: papirRadius.md,
              backgroundColor: papirColor.paper2,
              borderWidth: 1,
              borderColor: papirColor.line,
            }}
          >
            <PaperText role="small" color={papirColor.ink2}>
              Du har nået grænsen for nu. Prøv igen kl. {capResetLabel(chat.chatCap.resetsAt)}.
            </PaperText>
          </View>
        ) : null}

        {/* Composer */}
        <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 12, paddingBottom: 28, gap: 12 }}>
          {chat.data.length === 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {suggestions.data.map((s) => (
                <Chip key={s} label={s} onPress={() => sendText(s)} />
              ))}
            </ScrollView>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: papirColor.card,
              borderWidth: 1,
              borderColor: papirColor.line,
              borderRadius: papirRadius.pill,
              paddingVertical: 6,
              paddingLeft: 18,
              paddingRight: 6,
            }}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Spørg Zolva"
              placeholderTextColor={papirColor.ink3}
              style={{ flex: 1, fontSize: 15, color: papirColor.ink, maxHeight: 96 }}
              multiline
              accessibilityLabel="Chat-besked"
            />
            <ScaleButton
              scaleTo={0.9}
              haptic="light"
              onPress={() => sendText(input)}
              disabled={!input.trim() || chat.typing}
              accessibilityLabel="Send"
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                backgroundColor: input.trim() && !chat.typing ? papirColor.ink : papirColor.ink4,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ArrowUp size={17} color={papirColor.onInk} strokeWidth={2} />
            </ScaleButton>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
