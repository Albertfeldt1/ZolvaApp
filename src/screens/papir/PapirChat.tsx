import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { ArrowUp, Mic, Square, Trash2, Volume2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { deleteAsync } from 'expo-file-system/legacy';
import { ScaleButton } from '../../design/motion';
import { Chip, IconButton, PaperText, papirColor, papirFont, papirRadius, papirSpace } from '../../design/papir';
import { renderInlineMd, renderLinks } from '../../components/inline-md';
import {
  getTodayCalendarEvents,
  subscribeTodayCalendarEvents,
  type TodayCalendarEvent,
} from '../../lib/calendar-today-snapshot';
import { useChat, useChatSuggestions } from '../../lib/hooks';
import { subscribeFactExtracted } from '../../lib/profile-extractor';
import { subscribeNetworkExtracted } from '../../lib/network-extractor';
import { TranscribeCancelled, TranscribeError, transcribeAudio } from '../../lib/transcribe';
import { speak, stopSpeaking, TtsError } from '../../lib/tts';
import type { ChatMessage, SendDraftAction } from '../../lib/types';
import { consumeChatVoiceQuestion, subscribeChatVoiceQuestion, usePapirNav } from './nav';
import { PapirRecord } from './PapirRecord';
import { PushHeader } from './PushHeader';
import { useNow } from './useNow';

type SpeechPhase = 'loading' | 'playing';

function ZolvaMsg({
  text,
  speechPhase,
  onToggleSpeak,
}: {
  text: string;
  speechPhase: SpeechPhase | null;
  onToggleSpeak: () => void;
}) {
  // Model replies use **bold** markdown — render it instead of showing raw
  // asterisks (H5). Same helper as the classic ChatScreen.
  return (
    <View style={{ maxWidth: '84%', alignSelf: 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Zolva
        </PaperText>
        <ScaleButton
          scaleTo={0.9}
          haptic="light"
          onPress={onToggleSpeak}
          accessibilityLabel={speechPhase ? 'Stop oplæsning' : 'Læs svaret op'}
          style={{ padding: 6, margin: -6 }}
        >
          {speechPhase === 'loading' ? (
            // size som tal er Android-only — "small" (20pt) skaleres ned til ikonstørrelse.
            <ActivityIndicator size="small" color={papirColor.ink3} style={{ transform: [{ scale: 0.7 }] }} />
          ) : speechPhase === 'playing' ? (
            <Square size={12} color={papirColor.red} strokeWidth={2} fill={papirColor.red} />
          ) : (
            <Volume2 size={14} color={papirColor.ink3} strokeWidth={1.8} />
          )}
        </ScaleButton>
      </View>
      <PaperText role="body">{renderInlineMd(text, papirFont.uiSemi, papirColor.red)}</PaperText>
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
        {renderLinks(text, papirColor.onInk)}
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

const MAX_CHIPS = 4;
const MAX_CONTEXT_CHIPS = 3; // keep at least one familiar fallback in the row
const PREP_WINDOW_MS = 90 * 60 * 1000;
const CHIP_TITLE_CHAR_CAP = 28;

function chipClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

function truncateTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  return t.length > CHIP_TITLE_CHAR_CAP ? t.slice(0, CHIP_TITLE_CHAR_CAP - 1).trimEnd() + '…' : t;
}

// Context-driven suggestion chips for the empty state. Simple client-side
// rules over data that's already in memory (calendar snapshot + the mail
// items the suggestion hook fetches anyway) - a source that hasn't loaded
// just skips its chip. Fallbacks from the existing suggestion list fill the
// row so it's never empty.
function buildContextChips(opts: {
  now: Date;
  todayEvents: TodayCalendarEvent[];
  waitingMailCount: number;
  fallbacks: string[];
}): string[] {
  const { now, todayEvents, waitingMailCount, fallbacks } = opts;
  const contextual: string[] = [];
  const nowMs = now.getTime();

  const upcoming = todayEvents.find(
    (e) => !e.allDay && e.start.getTime() > nowMs && e.start.getTime() - nowMs <= PREP_WINDOW_MS,
  );
  if (upcoming) {
    contextual.push(`Forbered mig til ${truncateTitle(upcoming.title)} kl. ${chipClock(upcoming.start)}`);
  }
  if (waitingMailCount >= 2) contextual.push(`Gennemgå de ${waitingMailCount} mails der venter`);
  else if (waitingMailCount === 1) contextual.push('Hvad venter i min indbakke?');
  if (now.getDay() === 5 && now.getHours() >= 14) contextual.push('Opsummér min uge');
  if (now.getHours() < 10) contextual.push('Hvad er vigtigst i dag?');

  const out = contextual.slice(0, MAX_CONTEXT_CHIPS);
  for (const s of fallbacks) {
    if (out.length >= MAX_CHIPS) break;
    if (out.some((c) => c.trim().toLowerCase() === s.trim().toLowerCase())) continue;
    out.push(s);
  }
  return out.slice(0, MAX_CHIPS);
}

export function PapirChat() {
  const nav = usePapirNav();
  const chat = useChat();
  const suggestions = useChatSuggestions();
  const [input, setInput] = useState('');
  // Voice question flow: full-screen recorder → transcription → send as a
  // normal chat turn. The reply is NOT read aloud automatically — the user
  // opts in per message via the speaker button on the bubble.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Which assistant message is being spoken right now (one at a time).
  const [speech, setSpeech] = useState<{ msgId: string; phase: SpeechPhase } | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const countRef = useRef(0);
  // Ticks per minute (and on foreground) so the time-of-day chip rules stay
  // fresh - the tab is keep-alive mounted, a bare new Date() would freeze.
  const now = useNow();

  // Calendar snapshot for the "Forbered mig til …"-chip. Populated as a side
  // effect of the calendar fetches other screens already run; the tick just
  // re-renders when a fetch lands so the chip can appear without one here.
  const [calTick, setCalTick] = useState(0);
  useEffect(() => subscribeTodayCalendarEvents(() => setCalTick((t) => t + 1)), []);
  const chips = useMemo(
    () =>
      buildContextChips({
        now,
        todayEvents: getTodayCalendarEvents(now),
        waitingMailCount: suggestions.waitingMailCount,
        fallbacks: suggestions.data,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [now, calTick, suggestions.waitingMailCount, suggestions.data],
  );

  // "Noteret" micro-confirmation: when the fact-extractor lands a new pending
  // fact for a turn in THIS conversation, show a discreet line under the
  // assistant reply that produced it. Session-only - never persisted, and it
  // clears again on the next send.
  const [noted, setNoted] = useState<{ msgId: string; text: string } | null>(null);
  const messagesRef = useRef<ChatMessage[]>(chat.data);
  messagesRef.current = chat.data;
  useEffect(
    () =>
      subscribeFactExtracted((e) => {
        const msgId = e.source?.startsWith('chat:') ? e.source.slice('chat:'.length) : null;
        if (!msgId) return;
        if (!messagesRef.current.some((m) => m.id === msgId)) return;
        setNoted({ msgId, text: e.text });
        Haptics.selectionAsync().catch(() => {});
      }),
    [],
  );
  // Samme diskrete bekræftelse for Netværk: når netværks-ekstraktoren lander
  // en person for en tur i DENNE samtale, vises en tappelig linje under
  // svaret - tryk åbner personkortet.
  const [networkNoted, setNetworkNoted] = useState<{ msgId: string; personId: string; name: string; isNew: boolean } | null>(null);
  useEffect(
    () =>
      subscribeNetworkExtracted((e) => {
        const msgId = e.source?.startsWith('chat:') ? e.source.slice('chat:'.length) : null;
        if (!msgId) return;
        if (!messagesRef.current.some((m) => m.id === msgId)) return;
        setNetworkNoted({ msgId, personId: e.personId, name: e.name, isNew: e.isNew });
        Haptics.selectionAsync().catch(() => {});
      }),
    [],
  );

  // The line lands under the last bubble seconds after the reply - nudge the
  // scroll so it isn't hidden behind the composer.
  useEffect(() => {
    if (!noted) return;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [noted]);
  useEffect(() => {
    if (!networkNoted) return;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [networkNoted]);

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
    setNoted(null); // the confirmation belongs to the previous turn only
    stopSpeaking(); // a new turn makes the old spoken answer stale
    chat.send(trimmed);
  };

  // Stemme-spørgsmål fra optage-flowet (den store knap i bundnavigationen):
  // transskriptionen ruter hertil via push('chat') + requestChatVoiceQuestion.
  // Forbrug ved mount (spørgsmålet venter typisk før chatten er mounted) og
  // lyt derefter live. Refs frem for deps: apply må ikke re-køre effekten,
  // men skal altid se friske sendText/typing.
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  const typingRef = useRef(chat.typing);
  typingRef.current = chat.typing;
  useEffect(() => {
    const apply = () => {
      const q = consumeChatVoiceQuestion();
      if (!q) return;
      if (typingRef.current) {
        // En tur er allerede i gang — park spørgsmålet i composeren i stedet
        // for at tabe det på sendText's typing-guard.
        setInput(q);
        return;
      }
      sendTextRef.current(q);
    };
    apply();
    return subscribeChatVoiceQuestion(apply);
  }, []);

  // --- Oplæsning (TTS) ---------------------------------------------------
  // stopSpeaking() fires the previous utterance's onEnd, which clears
  // `speech` via the msgId guard — no manual reset needed on switches.
  const speakMessage = async (m: ChatMessage) => {
    setSpeech({ msgId: m.id, phase: 'loading' });
    try {
      await speak(m.text, () => setSpeech((s) => (s?.msgId === m.id ? null : s)));
      setSpeech((s) => (s?.msgId === m.id ? { msgId: m.id, phase: 'playing' } : s));
    } catch (e) {
      setSpeech((s) => (s?.msgId === m.id ? null : s));
      Alert.alert('Oplæsning', e instanceof TtsError ? e.message : 'Svaret kunne ikke læses op. Prøv igen.');
    }
  };

  const toggleSpeak = (m: ChatMessage) => {
    if (speech?.msgId === m.id) {
      stopSpeaking();
      return;
    }
    void speakMessage(m);
  };

  // Leaving the screen must not leave audio running.
  useEffect(() => () => stopSpeaking(), []);

  // --- Stemme-spørgsmål --------------------------------------------------
  const handleVoiceTake = async (uri: string) => {
    setTranscribing(true);
    try {
      const transcript = await transcribeAudio(uri);
      if (!transcript) {
        Alert.alert('Optagelse', 'Jeg kunne ikke høre noget. Prøv igen.');
        return;
      }
      if (chat.typing) {
        // A turn landed while we transcribed — park the text in the composer
        // instead of dropping it on sendText's typing guard.
        setInput(transcript);
        return;
      }
      sendText(transcript);
    } catch (e) {
      if (!(e instanceof TranscribeCancelled)) {
        Alert.alert('Optagelse', e instanceof TranscribeError ? e.message : 'Transskriberingen fejlede. Prøv igen.');
      }
    } finally {
      setTranscribing(false);
      // The recorder hands the file off to us — clean up the temp take.
      deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  };

  const confirmClear = () => {
    if (chat.data.length === 0) return;
    Alert.alert('Ryd samtalen?', 'Historikken slettes fra denne enhed og din konto.', [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Ryd',
        style: 'destructive',
        onPress: () => {
          stopSpeaking();
          void chat.clear();
        },
      },
    ]);
  };

  const renderMessage = (m: ChatMessage) => {
    const bubble =
      m.from === 'user' ? (
        <MeMsg text={m.text} />
      ) : (
        <ZolvaMsg
          text={m.text}
          speechPhase={speech?.msgId === m.id ? speech.phase : null}
          onToggleSpeak={() => toggleSpeak(m)}
        />
      );
    const drafts = m.drafts ?? [];
    const notedLine =
      noted && noted.msgId === m.id ? (
        <PaperText role="small" color={papirColor.ink3} style={{ maxWidth: '84%', alignSelf: 'flex-start' }}>
          Noteret – jeg husker: {renderLinks(noted.text, papirColor.red)}
        </PaperText>
      ) : null;
    const networkLine =
      networkNoted && networkNoted.msgId === m.id ? (
        <Pressable
          onPress={() => nav.push('networkPerson', { personId: networkNoted.personId })}
          accessibilityRole="button"
          accessibilityLabel={`Åbn ${networkNoted.name} i Netværk`}
          style={{ maxWidth: '84%', alignSelf: 'flex-start' }}
        >
          <PaperText role="small" color={papirColor.ink3}>
            {networkNoted.isNew ? 'Tilføjet til netværk: ' : 'Netværk opdateret: '}
            <PaperText role="small" color={papirColor.red}>
              {networkNoted.name}
            </PaperText>
          </PaperText>
        </Pressable>
      ) : null;
    if (drafts.length === 0 && !notedLine && !networkLine) return <View key={m.id}>{bubble}</View>;
    return (
      <View key={m.id} style={{ gap: 12 }}>
        {bubble}
        {drafts.map((d, i) => (
          <DraftCard key={`${m.id}-draft-${i}`} draft={d} onSend={() => chat.sendDraft(d).then((r) => r.ok)} />
        ))}
        {notedLine}
        {networkLine}
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
              {chips.map((s) => (
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
              selectionColor={papirColor.red}
              style={{ flex: 1, fontSize: 15, color: papirColor.ink, maxHeight: 96 }}
              multiline
              accessibilityLabel="Chat-besked"
            />
            <ScaleButton
              scaleTo={0.9}
              haptic="light"
              onPress={() => {
                stopSpeaking(); // recording mode and playback can't share the audio session
                setRecording(true);
              }}
              disabled={transcribing || chat.typing}
              accessibilityLabel="Stil et spørgsmål med stemmen"
              style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }}
            >
              {transcribing ? (
                <ActivityIndicator size="small" color={papirColor.ink3} />
              ) : (
                <Mic size={18} color={chat.typing ? papirColor.ink4 : papirColor.ink2} strokeWidth={1.8} />
              )}
            </ScaleButton>
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

        {/* Full-screen recorder for voice questions. Modal (not an inline
            overlay like PapirShell's) because the shell's bottom nav renders
            above this tab pane — a Modal is the only layer that covers it. */}
        <Modal
          visible={recording}
          animationType="slide"
          onRequestClose={() => setRecording(false)}
          presentationStyle="fullScreen"
        >
          <PapirRecord
            onStop={(uri) => {
              setRecording(false);
              void handleVoiceTake(uri);
            }}
            onClose={() => setRecording(false)}
          />
        </Modal>
      </View>
    </KeyboardAvoidingView>
  );
}
