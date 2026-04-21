import { ArrowUp, ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stone } from '../components/Stone';
import { formatClock, formatToday } from '../lib/date';
import { useChat } from '../lib/hooks';
import type { ChatMessage } from '../lib/types';
import { colors, fonts } from '../theme';

// Prompt starters aligned with Claude's available tools (reminders + notes).
const SUGGESTIONS = [
  'Mine påmindelser',
  'Husk at ringe i morgen',
  'Skriv en note',
  'Hvad har jeg noteret?',
];

type Props = { onBack: () => void; initialDraft?: string };

export function ChatScreen({ onBack, initialDraft }: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);

  const { data: messages, typing, send } = useChat();
  const [input, setInput] = useState(initialDraft ?? '');
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messages, typing]);

  const submit = (text: string) => {
    send(text);
    setInput('');
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.topBar}>
        <Pressable
          onPress={onBack}
          style={styles.roundBtn}
          accessibilityRole="button"
          accessibilityLabel="Tilbage"
        >
          <ChevronLeft size={18} color={colors.ink} strokeWidth={1.75} />
        </Pressable>
        <Stone size={34} mood="calm" />
        <View style={{ flex: 1 }}>
          <Text style={styles.botName}>Zolva</Text>
          <Text style={styles.botMeta}>Klar</Text>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.daySeparator}>{`${dateInfo.weekdayFull} · ${clock}`}</Text>
        {messages.length === 0 && (
          <Text style={styles.emptyHint}>Skriv en besked for at starte.</Text>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
        {typing && <TypingIndicator />}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.suggestScroll}
        contentContainerStyle={styles.suggestRow}
      >
        {SUGGESTIONS.map((q, i) => (
          <Pressable key={i} onPress={() => submit(q)} style={styles.suggestChip}>
            <Text style={styles.suggestText}>{q}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.inputBar}>
        <View style={styles.inputPill}>
          <TextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={() => submit(input)}
            placeholder="Skriv til Zolva…"
            placeholderTextColor={colors.fg3}
            style={styles.input}
            returnKeyType="send"
          />
          <Pressable
            style={styles.sendBtn}
            onPress={() => submit(input)}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <ArrowUp size={18} color={colors.paper} strokeWidth={2.4} />
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isZ = msg.from === 'zolva';
  return (
    <View
      style={[
        styles.bubbleRow,
        { flexDirection: isZ ? 'row' : 'row-reverse' },
      ]}
    >
      {isZ && <Stone size={26} />}
      <View
        style={[
          styles.bubble,
          isZ ? styles.bubbleZ : styles.bubbleU,
        ]}
      >
        <Text style={[styles.bubbleText, { color: isZ ? colors.ink : colors.paper }]}>{msg.text}</Text>
      </View>
    </View>
  );
}

function TypingIndicator() {
  return (
    <View style={[styles.bubbleRow, { flexDirection: 'row' }]}>
      <Stone size={26} mood="thinking" />
      <View style={[styles.bubble, styles.bubbleZ, { flexDirection: 'row', gap: 4 }]}>
        {[0, 1, 2].map((i) => (
          <TypingDot key={i} delay={i * 180} />
        ))}
      </View>
    </View>
  );
}

function TypingDot({ delay }: { delay: number }) {
  const op = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const seq = () =>
      Animated.sequence([
        Animated.timing(op, { toValue: 1, duration: 560, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.3, duration: 840, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]);
    const loop = Animated.loop(seq());
    const timer = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(timer);
      loop.stop();
    };
  }, [op, delay]);
  return <Animated.View style={[styles.typingDot, { opacity: op }]} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: Platform.OS === 'ios' ? 58 : 40,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.paper,
  },
  roundBtn: {
    width: 34, height: 34, borderRadius: 999,
    backgroundColor: colors.mist,
    alignItems: 'center', justifyContent: 'center',
  },
  botName: { fontFamily: fonts.uiSemi, fontSize: 15, color: colors.ink },
  botMeta: { fontFamily: fonts.ui, fontSize: 11.5, color: colors.fg3 },

  messagesContent: {
    padding: 16,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 10,
  },
  daySeparator: {
    textAlign: 'center',
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.fg3,
    paddingBottom: 8,
    paddingTop: 4,
  },
  emptyHint: {
    textAlign: 'center',
    marginTop: 40,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },

  bubbleRow: { gap: 8, alignItems: 'flex-end' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleZ: {
    backgroundColor: colors.paper,
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 4,
  },
  bubbleU: {
    backgroundColor: colors.ink,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 14,
  },
  bubbleText: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 21 },

  typingDot: { width: 6, height: 6, borderRadius: 999, backgroundColor: colors.stone },

  suggestScroll: { flexGrow: 0, flexShrink: 0 },
  suggestRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 6,
    alignItems: 'center',
  },
  suggestChip: {
    backgroundColor: colors.mist,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 999,
    marginRight: 6,
  },
  suggestText: { fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg2 },

  inputBar: {
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: colors.paper,
  },
  inputPill: {
    flexDirection: 'row', alignItems: 'center',
    gap: 8,
    backgroundColor: colors.mist,
    borderRadius: 22,
    paddingLeft: 16, paddingRight: 8, paddingVertical: 6,
  },
  input: {
    flex: 1, fontFamily: fonts.ui, fontSize: 15, color: colors.ink,
    paddingVertical: 6,
  },
  inputIconBtn: {
    width: 34, height: 34, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.mist,
  },
  sendBtn: {
    width: 34, height: 34, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.ink,
  },
});
