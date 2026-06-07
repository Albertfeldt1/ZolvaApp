import { ChevronLeft, Trash2 } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Keyboard,
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
import { GlassView } from 'expo-glass-effect';
import { LinearGradient } from 'expo-linear-gradient';
import Reanimated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Icon as DesignIcon } from '../design/primitives/Icon';
import { liquidGlassReady } from '../lib/liquid-glass';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { DrivePickerModal } from '../components/DrivePickerModal';
import { renderInlineMd } from '../components/inline-md';
import {
  MessageActionMenu,
  type BubbleRect,
  type MessageActionTarget,
} from '../components/MessageActionMenu';
import { formatClock, formatToday } from '../lib/date';
import { useChat, useChatSuggestions } from '../lib/hooks';
import { ingestPickedDriveFiles } from '../lib/onboarding-backfill';
import { presentPaywallIfNeeded } from '../lib/paywall';
import type { ChatMessage, SendDraftAction } from '../lib/types';

// Vertical space the floating chips + input dock occupy at rest. Used
// as ScrollView.contentContainerStyle.paddingBottom so the last message
// can scroll above the dock instead of being permanently pinned under
// it. Chips ~44pt + dock padding 12 + dock row ~36 + bottom safe-area
// reserve 24 ≈ 116pt; bumped to 130 for breathing room.
const BOTTOM_DOCK_RESERVE = 130;
// Same idea at the top - header floats absolutely so messages scroll
// underneath it; this padding pushes the first message clear of the
// header's bottom edge at rest. statusBarFallback (56) + header card
// (~52) + bottom padding (14) ≈ 122; padded to 140 for breathing room.
const TOP_HEADER_RESERVE = 140;

type Props = { onBack: () => void; initialDraft?: string; initialDraftAutoSend?: boolean };

export function ChatScreen({ onBack, initialDraft, initialDraftAutoSend }: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);

  const { t, type, fonts, radius, spacing, surface, shadows } = useTheme();

  const { data: messages, typing, send, clear, sendDraft, chatCap, clearChatCap } = useChat();
  const capped = React.useMemo(() => {
    if (!chatCap) return false;
    if (!chatCap.resetsAt) return true;
    return Date.now() < new Date(chatCap.resetsAt).getTime();
  }, [chatCap]);

  // Auto-clear the cap once the reset time passes while the screen is open.
  React.useEffect(() => {
    if (!chatCap?.resetsAt) return;
    const ms = new Date(chatCap.resetsAt).getTime() - Date.now();
    if (ms <= 0) { clearChatCap(); return; }
    const id = setTimeout(() => clearChatCap(), Math.min(ms, 2_147_483_000));
    return () => clearTimeout(id);
  }, [chatCap, clearChatCap]);

  // Composer focus is deferred so the keyboard doesn't race the chat
  // overlay's slide-in animation. SlideInDown runs ~320ms; we focus
  // ~340ms in so the keyboard's own slide is the second beat, not a
  // simultaneous shove that makes the entrance read as "spawned in".
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 340);
    return () => clearTimeout(t);
  }, []);

  // iOS-native confirmation dialog before wiping the chat history. The
  // destructive button is styled by the system so it picks up the red
  // affordance without any extra theming on our side. Cancel is the
  // default-emphasized action so an accidental double-tap doesn't nuke
  // the conversation.
  const confirmClear = () => {
    Alert.alert(
      'Slet samtale?',
      'Alle beskeder forsvinder. Det kan ikke fortrydes.',
      [
        { text: 'Annullér', style: 'cancel' },
        { text: 'Slet', style: 'destructive', onPress: () => clear() },
      ],
      { cancelable: true },
    );
  };
  const { data: suggestions } = useChatSuggestions();
  const [input, setInput] = useState(initialDraft ?? '');
  const [drivePickerVisible, setDrivePickerVisible] = useState(false);
  const [actionMenu, setActionMenu] = useState<MessageActionTarget | null>(null);
  // In-chat draft send ("Send svar" button). draftPreview drives the "Se
  // udkast" sheet; sendingId is the draft whose send is in flight; sentIds
  // remembers which drafts went out this session so the button stays "Sendt".
  // A single turn can carry several drafts, so these are keyed per draft
  // (`${messageId}#${index}`), not per message - otherwise sending one draft
  // would flip every draft on the message to "Sendt".
  const [draftPreview, setDraftPreview] = useState<{ draftKey: string; action: SendDraftAction } | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentIds, setSentIds] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<ScrollView>(null);

  // Tap "Send svar" → native confirm (guards against a mis-tap sending real
  // mail) → send the draft. On success flip the button to "✓ Sendt"; on
  // failure surface why so the user can retry.
  const confirmAndSendDraft = (draftKey: string, action: SendDraftAction) => {
    if (sendingId === draftKey || sentIds.has(draftKey)) return;
    const recipient = action.to[0] ?? 'modtageren';
    Alert.alert(
      'Send svar?',
      `Svaret sendes til ${recipient}.`,
      [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Send',
          onPress: async () => {
            setSendingId(draftKey);
            try {
              const res = await sendDraft(action);
              if (res.ok) {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setSentIds((cur) => new Set(cur).add(draftKey));
                setDraftPreview((cur) => (cur?.draftKey === draftKey ? null : cur));
              } else {
                Alert.alert('Kunne ikke sende', res.error ?? 'Prøv igen om lidt.');
              }
            } finally {
              setSendingId((cur) => (cur === draftKey ? null : cur));
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  // Long-press a chat bubble → iMessage-style pop + copy menu. The pop haptic
  // fires when the menu opens; the success haptic on copy.
  const openActionMenu = (m: ChatMessage, rect: BubbleRect) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setActionMenu({ id: m.id, text: m.text, rect, isUser: m.from === 'user' });
  };
  const copyFromMenu = async () => {
    if (!actionMenu) return;
    try {
      await Clipboard.setStringAsync(actionMenu.text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      // Clipboard can reject if the app is backgrounded; nothing to recover.
    }
    setActionMenu(null);
  };

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

  // Reliable scroll-to-bottom that doesn't depend on rAF timing. Fires once
  // the messages content is actually measured (initial open) and on every
  // size change after. First landing is instant (jump to bottom on open);
  // later ones animate so new messages glide in above the dock.
  const didInitialScroll = useRef(false);
  const onMessagesSizeChange = () => {
    scrollRef.current?.scrollToEnd({ animated: didInitialScroll.current });
    didInitialScroll.current = true;
  };

  // When the keyboard rises, bring the latest messages up with it so the dock
  // never covers them (the ScrollView shrinks under KAV padding but keeps its
  // offset otherwise).
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    });
    return () => sub.remove();
  }, []);

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
    // Outer paper-bg wrapper sits BETWEEN the App.tsx Animated.View
    // and the KeyboardAvoidingView. The Animated.View already paints
    // colors.paper (see App.tsx fix c72793f), but Reanimated's entering/
    // exiting animation occasionally drops the static backgroundColor
    // from the merged style array, leaving a transparent gap when KAV's
    // behavior=padding shrinks the inner content above the keyboard.
    // This non-animated wrapper has no entering animation so its bg
    // paint is guaranteed for the full chat-overlay bounds — Today
    // can't leak through the KAV's padding region even if the outer
    // Animated.View's bg is momentarily inactive.
    <View style={{ flex: 1, backgroundColor: t.paper }}>
      {/* Halo is a stable full-screen background BEHIND the
          KeyboardAvoidingView. Previously it lived inside the KAV, so when the
          keyboard added bottom padding the whole background compressed upward.
          Out here it stays put; the keyboard only lifts the content + dock. */}
      <GlassHaloLayer />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <View style={{ flex: 1, position: 'relative' }}>

        {/* Header - wrapped in a glass card so the back button + Stone +
            title sit on a backdrop instead of floating on the halo paper.
            Absolute-positioned at the top so messages scroll UNDER it
            (mirroring the dock pattern at the bottom). No scrim here -
            the user found it visually heavy on the chat surface; the
            header glass card alone provides enough separation. Other
            overlays (mail detail, notifications, etc.) own their own
            top treatments. pointerEvents box-none lets scroll gestures
            in the empty regions still reach the ScrollView. */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            paddingTop: spacing.statusBarFallback,
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.cardPad,
            zIndex: 1,
          }}
        >
          {liquidGlassReady ? (
            <GlassView
              glassEffectStyle="regular"
              colorScheme="auto"
              style={{ borderRadius: radius.card, overflow: 'hidden' }}
            >
              <HeaderRow
                onBack={onBack}
                onClear={confirmClear}
                t={t}
                fonts={fonts}
                type={type}
                radius={radius}
                spacing={spacing}
                surface={surface}
              />
            </GlassView>
          ) : (
            <GlassFrostedCard
              radius={radius.card}
              style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
            >
              <HeaderRow
                onBack={onBack}
                onClear={confirmClear}
                t={t}
                fonts={fonts}
                type={type}
                radius={radius}
                spacing={spacing}
                surface={surface}
              />
            </GlassFrostedCard>
          )}
          {/* Soft fade below the header so its bottom edge feathers into
              the chat surface instead of cutting hard. Same intent as
              the bottom dock scrim but fading the OPPOSITE direction
              (transparent at top, lightly tinted at bottom inverse) so
              the visual weight of the header dissipates downward. */}
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(252,251,248,0.55)', 'rgba(252,251,248,0)']}
            locations={[0, 1]}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              // Originally bottom:-28; cumulative nudges 15 + 25 + 40
              // + 10 = 90pt up. Gradient sits over the header card
              // and feathers from there.
              bottom: 62,
              height: 28,
            }}
          />
        </View>

        {/* Messages. ScrollView flex-fills the body and the chips +
            input dock float above it as absolutely-positioned siblings,
            so messages can scroll UNDER the dock. paddingBottom equal
            to (chips + dock height + safe-area) keeps the last message
            from getting pinned underneath the dock at rest. */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            padding: spacing.screenPad,
            paddingTop: TOP_HEADER_RESERVE,
            paddingBottom: BOTTOM_DOCK_RESERVE,
            gap: spacing.md - 2,
          }}
          showsVerticalScrollIndicator={false}
          automaticallyAdjustKeyboardInsets={false}
          contentInsetAdjustmentBehavior="never"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={onMessagesSizeChange}
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
            <Bubble key={m.id} msg={m} t={t} type={type} fonts={fonts} radius={radius} spacing={spacing} surface={surface} onPickDrive={() => setDrivePickerVisible(true)} onSendDraft={(a, key) => confirmAndSendDraft(key, a)} onPreviewDraft={(a, key) => setDraftPreview({ draftKey: key, action: a })} isDraftSending={(key) => sendingId === key} isDraftSent={(key) => sentIds.has(key)} onLongPress={(rect) => openActionMenu(m, rect)} hidden={actionMenu?.id === m.id} />
          ))}

          {typing && <TypingIndicator t={t} spacing={spacing} radius={radius} />}
        </ScrollView>

        {/* Floating chips + dock. Absolute-positioned at the bottom so
            chat content scrolls UNDER them - matches iMessage where the
            composer floats over the message stream. A vertical scrim
            sits behind everything in this stack: same color family as
            the underlying halo (transparent at the top, darken-toward-
            black at the bottom) so messages fade smoothly out of view
            instead of abruptly meeting the dock - mirrors ChatGPT's
            chat surface treatment. */}
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
          }}
        >
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(15,16,20,0)', 'rgba(15,16,20,0.22)']}
            locations={[0, 1]}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: -80,
              bottom: 0,
            }}
          />
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
                  backgroundColor: 'transparent',
                }}
                textStyle={{ ...type.bodySm, color: t.ink2 }}
                contentPadding={spacing.screenPad}
                gap={spacing.sm - 2}
              />
            </View>
          )}

          {/* Input dock - pill-shaped composer. iOS 26+ rides UIKit's
              Liquid Glass material via GlassView so the dock picks up
              and blurs whatever chat content scrolls behind it; older
              iOS / Android fall through to a transparent View with no
              backdrop. Submission via keyboard return (returnKeyType
              "send") - no inline send button. */}
          <View
            style={{
              paddingTop: spacing.md,
              paddingBottom: spacing.xl,
              paddingHorizontal: spacing.xxl,
            }}
          >
            {capped ? (
              <View
                style={{
                  marginBottom: spacing.sm,
                  padding: spacing.md,
                  borderRadius: radius.card,
                  backgroundColor: t.line,
                  gap: spacing.xs,
                }}
              >
                <Text style={{ ...type.body, color: t.ink, fontFamily: fonts.uiBold }}>
                  Du har brugt dine beskeder i denne uge
                </Text>
                <Text style={{ ...type.bodySm, color: t.ink3 }}>
                  Opgrader til Pro for ubegrænset chat.
                </Text>
                <Pressable
                  onPress={() => { void presentPaywallIfNeeded('pro').then((ok) => { if (ok) clearChatCap(); }); }}
                  style={({ pressed }) => ({
                    alignSelf: 'flex-start',
                    marginTop: spacing.xs,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    borderRadius: radius.pill,
                    backgroundColor: t.ink,
                    opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <Text style={{ ...type.body, color: '#FFFFFF', fontFamily: fonts.uiBold }}>
                    Opgrader til Pro
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {liquidGlassReady ? (
              <GlassView
                glassEffectStyle="regular"
                isInteractive
                colorScheme="auto"
                style={{ borderRadius: radius.pill, overflow: 'hidden' }}
              >
                <DockRow
                  fonts={fonts}
                  type={type}
                  t={t}
                  spacing={spacing}
                  input={input}
                  setInput={setInput}
                  typing={typing}
                  submit={submit}
                  inputRef={inputRef}
                  capped={capped}
                />
              </GlassView>
            ) : (
              <View
                style={{
                  borderRadius: radius.pill,
                  backgroundColor: surface.glass,
                  borderWidth: 1,
                  borderColor: surface.glassRim,
                  overflow: 'hidden',
                }}
              >
                <DockRow
                  fonts={fonts}
                  type={type}
                  t={t}
                  spacing={spacing}
                  input={input}
                  setInput={setInput}
                  typing={typing}
                  submit={submit}
                  inputRef={inputRef}
                  capped={capped}
                />
              </View>
            )}
          </View>
        </View>
        </View>
      </KeyboardAvoidingView>

      <MessageActionMenu
        target={actionMenu}
        onCopy={copyFromMenu}
        onClose={() => setActionMenu(null)}
      />

      <DrivePickerModal
        visible={drivePickerVisible}
        onClose={() => setDrivePickerVisible(false)}
        onPicked={(files) => {
          // Ingest picked docs as facts; the user can re-ask now that the
          // files are granted (drive_search will find them next turn).
          if (files.length > 0) void ingestPickedDriveFiles();
        }}
      />

      {/* "Se udkast" sheet - read the draft before sending. Rendered as an
          absolute overlay rather than a native <Modal> so it can't race the
          chat overlay's own presentation (the phantom-modal trap on iOS). */}
      {draftPreview && (
        <Reanimated.View
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(240)}
        >
          <Pressable
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,16,20,0.45)' }}
            accessibilityRole="button"
            accessibilityLabel="Luk udkast"
            onPress={() => setDraftPreview(null)}
          />
          <Reanimated.View
            entering={SlideInDown.duration(260)}
            exiting={SlideOutDown.duration(220)}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              maxHeight: '80%',
              backgroundColor: surface.bone,
              borderTopLeftRadius: radius.card,
              borderTopRightRadius: radius.card,
              paddingHorizontal: spacing.screenPad,
              paddingTop: spacing.md,
              paddingBottom: spacing.xxl,
              ...shadows.softCard,
            }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: t.ink3,
                marginBottom: spacing.md,
              }}
            />
            <Text style={{ fontFamily: fonts.uiBold, fontSize: 16, color: t.ink, marginBottom: 4 }}>
              {draftPreview.action.subject || '(intet emne)'}
            </Text>
            <Text style={{ ...type.bodySm, color: t.ink2, marginBottom: spacing.sm }}>
              Til: {draftPreview.action.to.join(', ') || '(ingen modtager)'}
            </Text>
            <ScrollView style={{ marginBottom: spacing.md }}>
              <Text style={{ ...type.body, color: t.ink }}>{draftPreview.action.body}</Text>
            </ScrollView>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
              <Pressable
                onPress={() => {
                  if (sendingId === draftPreview.draftKey || sentIds.has(draftPreview.draftKey)) return;
                  confirmAndSendDraft(draftPreview.draftKey, draftPreview.action);
                }}
                disabled={sendingId === draftPreview.draftKey || sentIds.has(draftPreview.draftKey)}
                accessibilityRole="button"
                accessibilityLabel="Send svar"
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: spacing.sm,
                  paddingHorizontal: spacing.lg,
                  borderRadius: radius.pill,
                  backgroundColor: sentIds.has(draftPreview.draftKey) ? surface.glassWeak : t.ink,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                {sendingId === draftPreview.draftKey && <ActivityIndicator size="small" color="#fff" />}
                <Text
                  style={{
                    fontFamily: fonts.uiBold,
                    fontSize: 14,
                    color: sentIds.has(draftPreview.draftKey) ? t.ink : '#fff',
                  }}
                >
                  {sentIds.has(draftPreview.draftKey)
                    ? '✓ Sendt'
                    : sendingId === draftPreview.draftKey
                      ? 'Sender…'
                      : 'Send svar'}
                </Text>
              </Pressable>
              <Pressable onPress={() => setDraftPreview(null)} accessibilityRole="button" accessibilityLabel="Luk">
                <Text style={{ fontFamily: fonts.uiBold, fontSize: 14, color: t.ink2 }}>Luk</Text>
              </Pressable>
            </View>
          </Reanimated.View>
        </Reanimated.View>
      )}
    </View>
  );
}

// ─── Inline markdown - bold segments ───────────────────────────────────────

// Header content (back button, Stone, "Zolva" title). Pulled out so
// the header can swap between Liquid Glass (iOS 26+) and the legacy
// GlassFrostedCard fallback without duplicating the row markup.
function HeaderRow(props: {
  onBack: () => void;
  onClear: () => void;
  t: ThemeSlice['t'];
  fonts: ThemeSlice['fonts'];
  type: ThemeSlice['type'];
  radius: ThemeSlice['radius'];
  spacing: ThemeSlice['spacing'];
  surface: ThemeSlice['surface'];
}) {
  const { onBack, onClear, t, fonts, type, radius, spacing, surface } = props;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.cardPad,
      }}
    >
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
        onPress={onClear}
        hitSlop={8}
        style={({ pressed }) => ({
          width: 34,
          height: 34,
          borderRadius: radius.pill,
          backgroundColor: surface.iconButton,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
        accessibilityRole="button"
        accessibilityLabel="Slet samtale"
      >
        <Trash2 size={16} color={t.ink2} strokeWidth={1.75} />
      </Pressable>
    </View>
  );
}

// The composer's plus icon + multiline TextInput row. Pulled out so the
// dock can swap its outer container between an iOS Liquid Glass surface
// (GlassView) and a plain hairline-bordered View on older OSes without
// duplicating the row content.
function DockRow(props: {
  fonts: ThemeSlice['fonts'];
  type: ThemeSlice['type'];
  t: ThemeSlice['t'];
  spacing: ThemeSlice['spacing'];
  input: string;
  setInput: (v: string) => void;
  typing: boolean;
  submit: (text: string) => void;
  inputRef: React.RefObject<TextInput | null>;
  capped?: boolean;
}) {
  const { fonts, type, t, spacing, input, setInput, typing, submit, inputRef, capped } = props;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm + 2,
        paddingHorizontal: spacing.md,
      }}
    >
      <Pressable
        hitSlop={8}
        onPress={() => {
          /* TODO: wire to attachments menu */
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        accessibilityRole="button"
        accessibilityLabel="Tilføj"
      >
        <DesignIcon.plus size={20} color={t.ink3} />
      </Pressable>
      <TextInput
        ref={inputRef}
        value={input}
        onChangeText={setInput}
        placeholder="Spørg Zolva"
        placeholderTextColor={t.ink4}
        // autoFocus removed: when the chat overlay slides up via
        // SlideInDown (320ms) and the TextInput auto-focuses, the iOS
        // keyboard's own slide animation races the chat's. Both
        // running simultaneously while KeyboardAvoidingView re-pads
        // the layout reads as "the chat just spawns in." Focus is
        // requested explicitly from a useEffect AFTER the entrance
        // animation completes, so each animation gets its own beat.
        multiline
        scrollEnabled
        blurOnSubmit
        style={{
          flex: 1,
          fontFamily: fonts.ui,
          fontSize: type.body.fontSize,
          color: t.ink,
          paddingTop: 0,
          paddingBottom: 0,
          maxHeight: 120,
        }}
        onSubmitEditing={() => !typing && input.trim() && submit(input.trim())}
        returnKeyType="send"
        accessibilityLabel="chat-input"
        editable={!capped}
      />
    </View>
  );
}

// renderInlineMd moved to ../components/inline-md (shared with the long-press
// action menu so the lifted copy matches the original).

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

function Bubble({
  msg,
  t,
  type,
  fonts,
  radius,
  spacing,
  surface,
  onPickDrive,
  onSendDraft,
  onPreviewDraft,
  isDraftSending,
  isDraftSent,
  onLongPress,
  hidden,
}: {
  msg: ChatMessage;
  onPickDrive?: () => void;
  onSendDraft?: (action: SendDraftAction, draftKey: string) => void;
  onPreviewDraft?: (action: SendDraftAction, draftKey: string) => void;
  isDraftSending?: (draftKey: string) => boolean;
  isDraftSent?: (draftKey: string) => boolean;
  onLongPress?: (rect: BubbleRect) => void;
  // Hidden (kept in layout) while its long-press menu is open, so only the
  // lifted copy in the overlay is visible — no doubled bubble.
  hidden?: boolean;
} & ThemeSlice) {
  const isZ = msg.from === 'zolva';
  const pressRef = useRef<View>(null);
  // Measure the bubble's window position so the long-press menu can pin its
  // enlarged copy exactly over the original.
  const measureAndOpen = () => {
    pressRef.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) onLongPress?.({ x, y, w, h });
    });
  };
  if (isZ) {
    return (
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-end' }}>
        <Stone size={28} jumpOnTap={false} />
        <View style={{ maxWidth: '82%', opacity: hidden ? 0 : 1 }}>
        <Pressable ref={pressRef} onLongPress={measureAndOpen} delayLongPress={300}>
        <GlassFrostedCard
          radius={18}
          style={{
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
          }}
        >
          <Text style={{ ...type.body, color: t.ink }}>
            {renderInlineMd(msg.text, fonts.uiBold)}
          </Text>
          {msg.action?.kind === 'pick_drive_files' && (
            <Pressable
              onPress={onPickDrive}
              accessibilityRole="button"
              accessibilityLabel={msg.action.label}
              style={({ pressed }) => ({
                alignSelf: 'flex-start',
                marginTop: spacing.sm,
                paddingVertical: spacing.xs,
                paddingHorizontal: spacing.md,
                borderRadius: radius.pill,
                backgroundColor: surface.glassWeak,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: t.ink }}>
                {msg.action.label}
              </Text>
            </Pressable>
          )}
          {/* A turn can carry several drafts (agent replied to multiple
              mails). Render a "Send svar" / "Se udkast" pair per draft, keyed
              per draft so each tracks its own sending/sent state. Falls back to
              the legacy single `action` send_draft for any pre-existing msg. */}
          {(() => {
            const drafts =
              msg.drafts ?? (msg.action?.kind === 'send_draft' ? [msg.action] : []);
            if (drafts.length === 0) return null;
            const multiple = drafts.length > 1;
            return drafts.map((draft, idx) => {
              const draftKey = `${msg.id}#${idx}`;
              const sending = isDraftSending?.(draftKey) ?? false;
              const sent = isDraftSent?.(draftKey) ?? false;
              return (
                <View key={draftKey} style={{ marginTop: spacing.sm }}>
                  {multiple && (
                    <Text
                      numberOfLines={1}
                      style={{
                        fontFamily: fonts.uiBold,
                        fontSize: 12,
                        color: t.ink2,
                        marginBottom: spacing.xs,
                      }}
                    >
                      {draft.to[0] ?? 'modtager'}
                      {draft.subject ? ` · ${draft.subject}` : ''}
                    </Text>
                  )}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                    }}
                  >
                    <Pressable
                      onPress={() => {
                        if (sending || sent) return;
                        onSendDraft?.(draft, draftKey);
                      }}
                      disabled={sending || sent}
                      accessibilityRole="button"
                      accessibilityLabel={sent ? 'Svar sendt' : 'Send svar'}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingVertical: spacing.xs + 2,
                        paddingHorizontal: spacing.md,
                        borderRadius: radius.pill,
                        backgroundColor: sent ? surface.glassWeak : t.ink,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      {sending && <ActivityIndicator size="small" color="#fff" />}
                      <Text
                        style={{
                          fontFamily: fonts.uiBold,
                          fontSize: 13,
                          color: sent ? t.ink : '#fff',
                        }}
                      >
                        {sent ? '✓ Sendt' : sending ? 'Sender…' : 'Send svar'}
                      </Text>
                    </Pressable>
                    {!sent && !sending && (
                      <Pressable
                        onPress={() => onPreviewDraft?.(draft, draftKey)}
                        accessibilityRole="button"
                        accessibilityLabel="Se udkast"
                      >
                        <Text
                          style={{
                            fontFamily: fonts.uiBold,
                            fontSize: 13,
                            color: t.ink2,
                            textDecorationLine: 'underline',
                          }}
                        >
                          Se udkast
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            });
          })()}
        </GlassFrostedCard>
        </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: 'row-reverse' }}>
      <View style={{ maxWidth: '75%', alignItems: 'flex-end', opacity: hidden ? 0 : 1 }}>
      <Pressable ref={pressRef} onLongPress={measureAndOpen} delayLongPress={300}>
      <View
        style={{
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
      </Pressable>
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
          {liquidGlassReady ? (
            <GlassView
              glassEffectStyle="regular"
              isInteractive
              colorScheme="auto"
              style={{ borderRadius: 9999, overflow: 'hidden' }}
            >
              <View style={[{ flexDirection: 'row' }, chipStyle]}>
                <Text style={textStyle}>{item}</Text>
              </View>
            </GlassView>
          ) : (
            <View style={[{ flexDirection: 'row' }, chipStyle]}>
              <Text style={textStyle}>{item}</Text>
            </View>
          )}
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
