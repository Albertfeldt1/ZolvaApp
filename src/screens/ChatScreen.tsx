import { ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Icon as DesignIcon } from '../design/primitives/Icon';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { formatClock, formatToday } from '../lib/date';
import { useChat, useChatSuggestions } from '../lib/hooks';
import type { ChatMessage } from '../lib/types';

type Props = { onBack: () => void; initialDraft?: string };

export function ChatScreen({ onBack, initialDraft }: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);

  const { t, type, fonts, radius, spacing, surface } = useTheme();

  const { data: messages, typing, send } = useChat();
  const { data: suggestions } = useChatSuggestions();
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
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />

        {/* Header — wrapped in a glass card so the back button + Stone +
            title sit on a backdrop instead of floating on the halo paper. */}
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
                onPress={onBack}
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

              <Stone size={36} />

              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600', letterSpacing: -0.4, color: t.ink }}>
                  Zolva
                </Text>
                <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none', letterSpacing: 0.6 }}>
                  Læser kalender og mail
                </Text>
              </View>

              <Pressable
                onPress={onBack}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Luk"
              >
                <Text style={{ fontFamily: fonts.ui, fontSize: 18, color: t.ink2 }}>×</Text>
              </Pressable>
            </View>
          </GlassFrostedCard>
        </View>

        {/* Messages */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            padding: spacing.screenPad,
            paddingTop: spacing.md,
            paddingBottom: spacing.md,
            gap: spacing.md - 2,
          }}
          showsVerticalScrollIndicator={false}
          automaticallyAdjustKeyboardInsets={false}
          contentInsetAdjustmentBehavior="never"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Text
            style={{
              ...type.eyebrow,
              textAlign: 'center',
              color: t.ink3,
              textTransform: 'none',
              paddingBottom: spacing.sm,
              paddingTop: spacing.xs,
            }}
          >
            {`${dateInfo.weekdayFull} · ${clock}`}
          </Text>

          {messages.length === 0 && (
            <Text
              style={{
                textAlign: 'center',
                marginTop: 40,
                fontFamily: 'Inter_500Medium_Italic',
                fontSize: 13,
                color: t.ink3,
              }}
            >
              Skriv en besked for at starte.
            </Text>
          )}

          {messages.map((m) => (
            <Bubble key={m.id} msg={m} t={t} type={type} fonts={fonts} radius={radius} spacing={spacing} surface={surface} />
          ))}

          {typing && <TypingIndicator t={t} spacing={spacing} radius={radius} />}
        </ScrollView>

        {/* Suggestion pills — wrapped in a glass card backdrop so the
            row reads as one element instead of loose chips on paper. */}
        {suggestions.length > 0 && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingBottom: spacing.sm }}>
            <GlassFrostedCard style={{ paddingVertical: spacing.sm }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: spacing.cardPad,
                  gap: spacing.sm - 2,
                  alignItems: 'center',
                }}
                keyboardShouldPersistTaps="handled"
              >
                {suggestions.map((q, i) => (
                  <Pressable key={`${i}-${q}`} onPress={() => submit(q)}>
                    <View
                      style={{
                        flexDirection: 'row',
                        paddingVertical: spacing.sm,
                        paddingHorizontal: spacing.md,
                        borderRadius: radius.pill,
                        backgroundColor: surface.scrim,
                      }}
                    >
                      <Text style={{ ...type.bodySm, color: t.ink2 }}>{q}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </GlassFrostedCard>
          </View>
        )}

        {/* Input dock */}
        <View style={{ padding: spacing.md, paddingBottom: spacing.xl }}>
          <GlassFrostedCard radius={radius.pill} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <DesignIcon.plus size={18} color={t.ink3} />
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Spørg om noget…"
                placeholderTextColor={t.ink4}
                style={{
                  flex: 1,
                  fontFamily: fonts.ui,
                  fontSize: type.body.fontSize,
                  color: t.ink,
                  paddingVertical: 0,
                }}
                onSubmitEditing={() => input.trim() && submit(input.trim())}
                returnKeyType="send"
              />
              <Pressable
                onPress={() => input.trim() && submit(input.trim())}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: radius.pill,
                  backgroundColor: t.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel="Send"
              >
                <DesignIcon.send size={14} color="#FFFFFF" />
              </Pressable>
            </View>
          </GlassFrostedCard>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Inline markdown — bold segments ───────────────────────────────────────

function renderInlineMd(text: string, boldFamily: string): React.ReactNode[] {
  const parts = text.split(/\*\*([\s\S]+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <Text key={i} style={{ fontFamily: boldFamily }}>{part}</Text>
      : part,
  );
}

// ─── Theme-prop types passed down to sub-components ────────────────────────

type ThemeSlice = {
  t: ReturnType<typeof useTheme>['t'];
  type: ReturnType<typeof useTheme>['type'];
  fonts: ReturnType<typeof useTheme>['fonts'];
  radius: ReturnType<typeof useTheme>['radius'];
  spacing: ReturnType<typeof useTheme>['spacing'];
  surface: ReturnType<typeof useTheme>['surface'];
};

// ─── Bubble ────────────────────────────────────────────────────────────────

function Bubble({ msg, t, type, fonts, radius, spacing }: { msg: ChatMessage } & ThemeSlice) {
  const isZ = msg.from === 'zolva';
  if (isZ) {
    return (
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' }}>
        <Stone size={28} jumpOnTap={false} />
        <GlassFrostedCard
          radius={18}
          style={{
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
            maxWidth: '82%',
          }}
        >
          <Text style={{ ...type.body, color: t.ink }}>
            {renderInlineMd(msg.text, fonts.uiBold)}
          </Text>
        </GlassFrostedCard>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row-reverse' }}>
      <View
        style={{
          maxWidth: '75%',
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.cardPad,
          backgroundColor: t.ink,
          borderRadius: 18,
          borderBottomRightRadius: 6,
        }}
      >
        <Text style={{ ...type.body, color: '#fff' }}>
          {renderInlineMd(msg.text, fonts.uiBold)}
        </Text>
      </View>
    </View>
  );
}

// ─── Typing indicator ──────────────────────────────────────────────────────

function TypingIndicator({ t, spacing, radius }: Pick<ThemeSlice, 't' | 'spacing' | 'radius'>) {
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' }}>
      <Stone size={28} jumpOnTap={false} />
      <GlassFrostedCard
        radius={18}
        style={{
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.cardPad,
          flexDirection: 'row',
          gap: 4,
        }}
      >
        {[0, 1, 2].map((i) => (
          <TypingDot key={i} delay={i * 180} stoneColor={t.ink3} />
        ))}
      </GlassFrostedCard>
    </View>
  );
}

function TypingDot({ delay, stoneColor }: { delay: number; stoneColor: string }) {
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
  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: stoneColor,
        opacity: op,
      }}
    />
  );
}
