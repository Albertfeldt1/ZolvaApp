import { ChevronLeft } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  NativeScrollEvent,
  NativeSyntheticEvent,
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

type Props = { onBack: () => void; initialDraft?: string; initialDraftAutoSend?: boolean };

export function ChatScreen({ onBack, initialDraft, initialDraftAutoSend }: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);

  const { t, type, fonts, radius, spacing, surface } = useTheme();

  const { data: messages, typing, send } = useChat();
  const { data: suggestions } = useChatSuggestions();
  const [input, setInput] = useState(initialDraft ?? '');
  const scrollRef = useRef<ScrollView>(null);

  // Auto-send the seeded draft once on mount when callers (e.g. observation
  // CTAs from the Today screen) want the chat to act, not just open with
  // text waiting. Guarded by a ref so a re-render with the same prop
  // doesn't double-fire.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!initialDraftAutoSend) return;
    if (!initialDraft || !initialDraft.trim()) return;
    autoSentRef.current = true;
    // Defer one frame so the ChatScreen is fully mounted before send fires
    // its tool-call loop - otherwise the typing indicator can race the
    // initial scroll layout and look like the message never sent.
    requestAnimationFrame(() => {
      send(initialDraft);
      setInput('');
    });
  }, [initialDraft, initialDraftAutoSend, send]);

  useEffect(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [messages, typing]);

  const submit = (text: string) => {
    // Hard gate: never fire a second send while the previous one is still
    // running. Prevents users from spam-tapping suggestion chips (or the
    // send button) and queuing up a stack of in-flight chat turns, which
    // races the tool-call loop and corrupts the message history.
    if (typing) return;
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

        {/* Header - wrapped in a glass card so the back button + Stone +
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

        {/* Suggestion pills - naked chips (no card backdrop) tucked just
            above the input. Infinite horizontal scroll: the data is
            tripled and the list silently snaps from the trailing copy
            back to the middle copy when the user scrolls past it, so
            either direction loops forever without a visible seam. */}
        {suggestions.length > 0 && (
          <View style={{ paddingBottom: spacing.xs, opacity: typing ? 0.4 : 1 }}>
            <SuggestionsCarousel
              suggestions={suggestions}
              onSelect={submit}
              disabled={typing}
              chipStyle={{
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                borderRadius: radius.pill,
                backgroundColor: surface.scrim,
              }}
              textStyle={{ ...type.bodySm, color: t.ink2 }}
              contentPadding={spacing.screenPad}
              gap={spacing.sm - 2}
            />
          </View>
        )}

        {/* Input dock */}
        <View style={{ padding: spacing.md, paddingBottom: spacing.xl }}>
          {/* Use card (24) instead of pill (9999) - once the input grows
              multi-line the pill arc has a ~60pt radius and the curve
              eats into the bottom-left/bottom-right corners where the
              plus icon and send button sit, cropping them visually. */}
          <GlassFrostedCard radius={radius.card} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <DesignIcon.plus size={18} color={t.ink3} />
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="Spørg om noget…"
                placeholderTextColor={t.ink4}
                multiline
                scrollEnabled
                blurOnSubmit
                style={{
                  flex: 1,
                  fontFamily: fonts.ui,
                  fontSize: type.body.fontSize,
                  color: t.ink,
                  // paddingTop/paddingBottom: 0 overrides iOS multiline's
                  // implicit padding so the empty composer matches the
                  // single-line height the dock used before. Cap at 120pt
                  // (≈ 5 lines) and scroll internally past that.
                  paddingTop: 0,
                  paddingBottom: 0,
                  maxHeight: 120,
                }}
                onSubmitEditing={() => !typing && input.trim() && submit(input.trim())}
                returnKeyType="send"
                editable={true}
              />
              <Pressable
                onPress={() => !typing && input.trim() && submit(input.trim())}
                disabled={typing || input.trim().length === 0}
                style={({ pressed }) => ({
                  width: 32,
                  height: 32,
                  borderRadius: radius.pill,
                  backgroundColor: t.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: typing || input.trim().length === 0 ? 0.4 : pressed ? 0.7 : 1,
                })}
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: typing || input.trim().length === 0 }}
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

// ─── Inline markdown - bold segments ───────────────────────────────────────

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

// Infinite horizontal scroll for suggestion chips. Mirrors the data N×
// (5 copies) and silently jumps from the outermost copies back toward
// the middle when the user crosses a boundary, so swiping in either
// direction loops forever with no visible seam. 5 copies (vs 3) gives
// the user 3 full unique-prompt scroll-distances of safe travel before
// any snap fires - enough that the boundary teleport never happens
// during the visible portion of a normal swipe.
type SuggestionsCarouselProps = {
  suggestions: string[];
  onSelect: (q: string) => void;
  // True while the AI is still answering the previous turn. Chips ignore
  // taps so users can't spam-queue messages mid-response.
  disabled?: boolean;
  chipStyle: object;
  textStyle: object;
  contentPadding: number;
  gap: number;
};

function SuggestionsCarousel({
  suggestions,
  onSelect,
  disabled = false,
  chipStyle,
  textStyle,
  contentPadding,
  gap,
}: SuggestionsCarouselProps) {
  const listRef = useRef<FlatList<string>>(null);
  const contentWidth = useRef(0);
  const initialised = useRef(false);

  // 5 copies. Land in copy index 2 (middle); copies 0 and 4 are bumpers
  // we snap back from. Gives the user 3 unique-list widths of safe scroll
  // before any teleport.
  const COPIES = 5;
  const data = useMemo(
    () => Array(COPIES).fill(null).flatMap(() => suggestions),
    [suggestions],
  );

  const onContentSizeChange = (w: number) => {
    contentWidth.current = w;
    if (!initialised.current && w > 0) {
      initialised.current = true;
      // Land in the middle copy (index 2 of 5) on first layout.
      listRef.current?.scrollToOffset({ offset: (w / COPIES) * 2, animated: false });
    }
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const w = contentWidth.current;
    if (w === 0) return;
    const x = e.nativeEvent.contentOffset.x;
    const oneCopy = w / COPIES;
    // Snap when the user has fully entered the outermost copy (index 4
    // for forward, index 0 for backward). Teleport by one full unique-
    // list width back toward center, preserving sub-copy offset so the
    // jump is invisible.
    if (x >= 4 * oneCopy) {
      listRef.current?.scrollToOffset({ offset: x - oneCopy, animated: false });
    } else if (x < oneCopy) {
      listRef.current?.scrollToOffset({ offset: x + oneCopy, animated: false });
    }
  };

  return (
    <FlatList
      ref={listRef}
      horizontal
      data={data}
      keyExtractor={(item, i) => `${i}-${item}`}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onSelect(item)}
          disabled={disabled}
          style={({ pressed }) => [pressed && !disabled && { opacity: 0.6 }]}
        >
          <View style={[{ flexDirection: 'row' }, chipStyle]}>
            <Text style={textStyle}>{item}</Text>
          </View>
        </Pressable>
      )}
      ItemSeparatorComponent={() => <View style={{ width: gap }} />}
      contentContainerStyle={{
        paddingHorizontal: contentPadding,
        alignItems: 'center',
      }}
      showsHorizontalScrollIndicator={false}
      onContentSizeChange={onContentSizeChange}
      onMomentumScrollEnd={onMomentumScrollEnd}
      keyboardShouldPersistTaps="handled"
    />
  );
}
