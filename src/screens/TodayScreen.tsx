import AsyncStorage from '@react-native-async-storage/async-storage';
import { Bookmark, Moon, Sun, Sunrise, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useAuth } from '../lib/auth';
import { loadCredential } from '../lib/icloud-credentials';
import { TodayAgentFeed } from '../components/TodayAgentFeed';
import { ProposalDetailModal } from '../components/ProposalDetailModal';
import { AgentActionDetailModal } from '../components/AgentActionDetailModal';
import { OpenLoopsModal } from '../components/OpenLoopsModal';
import { useOpenCommitments } from '../lib/agent-commitments';
import type { ProposedActionRow } from '../lib/agent-proposals';
import type { AgentActionRow } from '../lib/agent-feed';
import { BriefBanner } from '../components/BriefBanner';
import { CountUp } from '../components/CountUp';
import { DayRibbon } from '../components/DayRibbon';
import { BriefHistoryModal } from '../components/BriefHistoryModal';
import { BriefModal } from '../components/BriefModal';
import { ObservationHistoryModal } from '../components/ObservationHistoryModal';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { SkeletonRow } from '../components/Skeleton';
import type { Brief } from '../lib/briefs';
import { fetchBriefById, useTodayBrief } from '../lib/briefs';
import { formatToday, greeting } from '../lib/date';
import {
  useHasProvider,
  useInboxCounts,
  useInboxWaiting,
  useNotes,
  useObservations,
  usePendingFacts,
  useReminders,
  useUpcoming,
  useUser,
} from '../lib/hooks';
import type {
  Fact,
  InboxMail,
  Observation,
  ObservationAction,
  Reminder,
  UpcomingEvent,
} from '../lib/types';
import { colors, fonts as legacyFonts } from '../theme';
import { plural, translateProviderError } from '../utils/danish';
import { isPendingAndDueOrUpcoming } from '../lib/reminders';
import { useTheme } from '../design/useTheme';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { TopBar } from '../design/primitives/TopBar';
import { Icon as DesignIcon } from '../design/primitives/Icon';
import { Stone } from '../components/Stone';

const toneColor = (tone: UpcomingEvent['tone']) =>
  tone === 'sage' ? colors.sage : tone === 'clay' ? colors.clay : tone === 'warning' ? colors.warning : colors.stone;

type Props = {
  onOpenChat: () => void;
  onOpenChatWithPrompt: (prompt: string, opts?: { autoSend?: boolean }) => void;
  onOpenMail: (mail: InboxMail, opts?: { autoDraft?: boolean }) => void;
  onGoToSettings: () => void;
  onGoToMemory: () => void;
  onGoToCalendar: () => void;
  onOpenNotifications: () => void;
  onOverDarkChange?: (over: boolean) => void;
  // Set by App whenever a brief push or in-app notification is tapped.
  // The nonce changes per tap so re-tapping the same brief re-opens it.
  // briefId is omitted for generic deep links (e.g. zolva://today#brief),
  // in which case we fall back to today's cached brief.
  briefOpenRequest?: { nonce: number; briefId?: string };
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  // True when this tab is the visible one. Tabs stay mounted across switches,
  // so the screen needs an explicit signal to re-sync host chrome state when
  // it becomes active again.
  isActive?: boolean;
};

const PILL_CLEARANCE = 76;

// Storage key for dismissed-observation ids. Versioned so a future schema
// change (e.g. moving to (id, dismissedAt) tuples) doesn't collide with
// the current array-of-string blob.
const observationDismissKey = (uid: string) =>
  `zolva.observations.dismissed.v1.${uid}`;
// Small chevron / icon glyph size used inside cards.
const SMALL_GLYPH = 14;

export function TodayScreen({
  onOpenChat,
  onOpenChatWithPrompt,
  onOpenMail,
  onGoToSettings,
  onGoToMemory,
  onGoToCalendar,
  onOpenNotifications,
  onOverDarkChange,
  briefOpenRequest,
  onOpenIcloudSetup,
  isActive = true,
}: Props) {
  const today = useMemo(() => new Date(), []);
  const dateInfo = useMemo(() => formatToday(today), [today]);
  const hello = useMemo(() => greeting(today), [today]);
  const { bottom: chromeBottom } = useChromeInsets();

  const theme = useTheme();
  const { t, type, fonts, radius, spacing, surface, shadows, blur, heroStat } = theme;

  const { user: authUser } = useAuth();
  const userId = authUser?.id ?? '';
  const [icloudExpired, setIcloudExpired] = useState(false);
  const [icloudExpiredEmail, setIcloudExpiredEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setIcloudExpired(false); return; }
    const refresh = () => {
      void loadCredential(userId).then((c) => {
        if (cancelled) return;
        setIcloudExpired(c.kind === 'invalid');
        setIcloudExpiredEmail(c.kind === 'invalid' ? c.credential.email : null);
      });
    };
    refresh();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { cancelled = true; sub.remove(); };
  }, [userId]);

  const { data: user } = useUser();
  const { data: observations, error: observationsError } = useObservations();
  const {
    data: upcoming,
    loading: upcomingLoading,
    error: upcomingError,
    todayMeetingCount,
    todayEvents,
  } = useUpcoming();
  const { data: waiting, read: readMails } = useInboxWaiting();
  // Headline counts come from server (Gmail labels API, Graph mailFolders,
  // iCloud IMAP STATUS) so the displayed numbers don't drift with the
  // per-fetch limit window. The list itself still flows through useInboxWaiting.
  const inboxCounts = useInboxCounts();
  const { data: reminders } = useReminders();
  const { data: notes } = useNotes();
  const hasProvider = useHasProvider();
  const { data: pendingFacts, accept: acceptFact, reject: rejectFactHook } = usePendingFacts();
  const { brief, markRead: markBriefRead } = useTodayBrief();
  const [viewingBrief, setViewingBrief] = useState<Brief | null>(null);
  const [historyKind, setHistoryKind] = useState<'morning' | 'midday' | 'evening' | null>(null);
  const [observationHistoryOpen, setObservationHistoryOpen] = useState(false);

  // Notification taps: App.tsx sets briefOpenRequest with a per-tap nonce.
  // Open the matching brief - by id when we have one, falling back to today's
  // cached brief for generic deep links. Fetching by id avoids the race where
  // the requested brief isn't the cached "today" one (or hasn't loaded yet).
  const lastBriefNonceRef = useRef(0);
  useEffect(() => {
    const req = briefOpenRequest;
    if (!req || req.nonce === 0 || req.nonce === lastBriefNonceRef.current) return;
    lastBriefNonceRef.current = req.nonce;
    if (!req.briefId) {
      if (brief) setViewingBrief(brief);
      return;
    }
    if (brief && brief.id === req.briefId) {
      setViewingBrief(brief);
      return;
    }
    let cancelled = false;
    void fetchBriefById(req.briefId).then((b) => {
      if (!cancelled && b) setViewingBrief(b);
    });
    return () => { cancelled = true; };
  }, [briefOpenRequest, brief]);

  // Persist dismissed observations per-user across app launches; without
  // this, every cold start re-shows everything the user already swiped
  // away in "Hvad jeg har bemærket".
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [dismissedHydrated, setDismissedHydrated] = useState(false);
  useEffect(() => {
    setDismissedIds(new Set());
    setDismissedHydrated(false);
    if (!userId) {
      setDismissedHydrated(true);
      return;
    }
    let cancelled = false;
    AsyncStorage.getItem(observationDismissKey(userId))
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          try {
            const ids = JSON.parse(raw);
            if (Array.isArray(ids)) setDismissedIds(new Set(ids));
          } catch {}
        }
      })
      .finally(() => {
        if (!cancelled) setDismissedHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  useEffect(() => {
    if (!dismissedHydrated || !userId) return;
    AsyncStorage.setItem(
      observationDismissKey(userId),
      JSON.stringify(Array.from(dismissedIds)),
    ).catch(() => {});
  }, [dismissedIds, dismissedHydrated, userId]);
  const visibleObservations = useMemo(
    () => observations.filter((o) => !dismissedIds.has(o.id)),
    [observations, dismissedIds],
  );
  const dismissObservation = (id: string) =>
    setDismissedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  const handleObservationAction = (
    action: ObservationAction | undefined,
    observation?: { text: string; cta: string },
  ) => {
    if (!action || action.kind === 'chat') {
      onOpenChat();
      return;
    }
    if (action.kind === 'prompt') {
      // Prompt actions are agentic - the AI is expected to execute via its
      // tools. Auto-send so the user doesn't have to tap a second time.
      onOpenChatWithPrompt(action.prompt, { autoSend: true });
      return;
    }
    // openMail / mailDraft - search across both waiting AND read so a
    // mail the user already read still resolves. Without this, the action
    // silently falls through to chat as soon as the mail leaves the unread
    // bucket, which is what produced the inconsistent simulator-vs-phone
    // behaviour. mailDraft additionally signals InboxDetailScreen to
    // auto-trigger draft generation, skipping the chat round-trip the
    // user dislikes.
    const mail =
      waiting.find((m) => m.id === action.mailId) ??
      readMails.find((m) => m.id === action.mailId);
    if (mail) {
      onOpenMail(mail, { autoDraft: action.kind === 'mailDraft' });
      return;
    }
    // Mail isn't in either list - likely archived, dismissed, or the
    // observation was generated against a stale fetch. Drop into chat
    // with a synthesized prompt so something useful still happens. The
    // chat AI can search/list mail to find what the observation meant.
    if (observation) {
      onOpenChatWithPrompt(
        `${observation.cta}: ${observation.text}`,
        { autoSend: true },
      );
    } else {
      onOpenChat();
    }
  };

  // The "Hvad jeg har bemærket" card caps the total displayed items -
  // pending facts + observations - at FEED_OBSERVATION_COUNT. Pending
  // facts go first (they need a user decision), then observations fill
  // any remaining slots. Anything past the cap is reachable via the
  // "Vis alle" modal.
  const FEED_OBSERVATION_COUNT = 4;
  const feedFacts = pendingFacts.slice(0, FEED_OBSERVATION_COUNT);
  const remainingSlots = Math.max(0, FEED_OBSERVATION_COUNT - feedFacts.length);
  // Cross-dedup observations against the pending-fact texts that share the
  // card. Without this the model can echo a fact ("Du arbejder med Mette på
  // Q3-budget") as an observation in the same render and the user sees the
  // same insight stacked twice. Normalize for comparison so trailing
  // punctuation / casing differences still collapse.
  const dedupedObservations = useMemo(() => {
    const factKeys = new Set(
      feedFacts.map((f) =>
        f.text
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .replace(/[.!?…]+$/u, '')
          .trim(),
      ),
    );
    const seenObsKeys = new Set<string>();
    return visibleObservations.filter((o) => {
      const key = o.text
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.!?…]+$/u, '')
        .trim();
      if (factKeys.has(key)) return false;
      if (seenObsKeys.has(key)) return false;
      seenObsKeys.add(key);
      return true;
    });
  }, [feedFacts, visibleObservations]);
  const feedObservations = dedupedObservations.slice(0, remainingSlots);
  const hasMoreObservations =
    pendingFacts.length + dedupedObservations.length > FEED_OBSERVATION_COUNT;
  const [observationsModalOpen, setObservationsModalOpen] = useState(false);
  const [selectedProposal, setSelectedProposal] = useState<ProposedActionRow | null>(null);
  const [selectedAction, setSelectedAction] = useState<AgentActionRow | null>(null);
  const [showOpenLoops, setShowOpenLoops] = useState(false);
  // True when the agent feed has nothing to show. Drives the unified
  // quiet-state card (Næste + agent-empty + time-of-day as one card).
  const [agentEmpty, setAgentEmpty] = useState(true);
  const { rows: openLoops } = useOpenCommitments(userId || null);

  // Match the MemoryScreen filter: pending + dueAt within 5min past - so a
  // reminder that already fired and decayed stops counting toward the
  // "1 påmindelse" preview and stops showing in the Husk preview row.
  const pendingReminders = useMemo(
    () =>
      reminders
        .filter((r) => isPendingAndDueOrUpcoming(r, today))
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)),
    [reminders, today],
  );
  const showHuskPreview = pendingReminders.length > 0 || notes.length > 0;

  const ribbonEvents = useMemo(() => {
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);
    const toHour = (d: Date) => d.getHours() + d.getMinutes() / 60;
    // Cycle through the active direction's accent palette instead of the
    // event's native calendar color - Google Blueberry blue / Sage green
    // clash with the warm-orange Glass & Air look. Same palette the
    // previous inline ribbon used.
    const palette = [t.cal, t.today, t.mem, t.inbox];
    return todayEvents
      .filter((e) => !e.allDay && e.start < endOfDay && e.end > startOfDay)
      .map((e, i) => ({
        id: e.id,
        startHour: toHour(e.start),
        endHour: toHour(e.end),
        title: e.title,
        start: e.start,
        end: e.end,
        color: palette[i % palette.length],
        location: e.location,
        description: e.description,
        attendees: e.attendees,
      }));
  }, [todayEvents, today, t.cal, t.today, t.mem, t.inbox]);

  const scrollYRef = useRef(0);
  const viewportHRef = useRef(0);
  const darkYRef = useRef<number | null>(null);
  const lastOverRef = useRef<boolean | null>(null);

  const checkOverDark = () => {
    if (!onOverDarkChange || darkYRef.current === null || viewportHRef.current === 0) return;
    const darkTop = darkYRef.current - scrollYRef.current;
    const pillTop = viewportHRef.current - PILL_CLEARANCE;
    const over = darkTop < pillTop;
    if (over !== lastOverRef.current) {
      lastOverRef.current = over;
      onOverDarkChange(over);
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
    checkOverDark();
  };

  useEffect(() => {
    return () => {
      if (onOverDarkChange && lastOverRef.current) onOverDarkChange(false);
    };
  }, [onOverDarkChange]);

  // When the tab becomes active again, re-publish the chrome dark state from
  // the preserved scroll position (lastOverRef). When deactivated, clear so
  // the chrome doesn't stay dark while another tab is showing.
  useEffect(() => {
    if (!onOverDarkChange) return;
    if (isActive) {
      checkOverDark();
    } else if (lastOverRef.current) {
      lastOverRef.current = false;
      onOverDarkChange(false);
    }
  }, [isActive, onOverDarkChange]);

  // "Næste" section content (header + events list / empty state). Factored out
  // so it can live either in its own card or inside the unified quiet-state card.
  const naesteSection = (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          paddingBottom: spacing.md,
        }}
      >
        <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>Næste</Text>
        <Text style={{ ...type.eyebrow, color: t.ink3 }}>
          {upcoming.length > 0 ? (<><CountUp to={upcoming.length} /> i dag</>) : '-'}
        </Text>
      </View>

      {upcoming.length === 0 ? (
        upcomingLoading && hasProvider && !upcomingError ? (
          <View>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : hasProvider ? (
          (() => {
            const err = upcomingError ? translateProviderError(upcomingError) : null;
            const isAuth = err?.kind === 'auth';
            return (
              <EmptyState
                mood="calm"
                title={
                  err
                    ? err.kind === 'network'
                      ? 'Ingen forbindelse'
                      : 'Kunne ikke hente kalender'
                    : 'Ingen aftaler i dag'
                }
                body={err ? err.message : 'Du har en rolig dag foran dig.'}
                ctaLabel={isAuth ? 'Gå til indstillinger' : undefined}
                onCta={isAuth ? onGoToSettings : undefined}
              />
            );
          })()
        ) : (
          <EmptyState
            mood="calm"
            title="Ingen aftaler i dag"
            body="Forbind din kalender, så samler jeg dagens møder her."
            ctaLabel="Forbind kalender"
            onCta={onGoToSettings}
          />
        )
      ) : (
        <View style={{ gap: spacing.md - 2 }}>
          {upcoming.slice(0, 5).map((e, i) => (
            <TouchableOpacity
              key={e.id}
              activeOpacity={0.55}
              onPress={() => {
                Haptics.selectionAsync().catch(() => {});
                onGoToCalendar();
              }}
              accessibilityRole="button"
              accessibilityLabel={`${e.title}, ${e.time} - åbn kalender`}
              hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
              style={[
                { flexDirection: 'row', alignItems: 'center', gap: spacing.cardPad, paddingVertical: spacing.md },
                i > 0 && { borderTopWidth: 1, borderTopColor: t.line },
              ]}
            >
              <View
                pointerEvents="none"
                style={{ width: 6, alignSelf: 'stretch', borderRadius: radius.pill, backgroundColor: toneColor(e.tone) }}
              />
              <View pointerEvents="none" style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                  <Text style={{ fontFamily: fonts.display, fontSize: type.title.fontSize - 2, fontWeight: '600', letterSpacing: -0.3, color: t.ink }}>{e.time}</Text>
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: type.bodySm.fontSize, color: t.ink, flexShrink: 1 }} numberOfLines={1}>{e.title}</Text>
                </View>
                <Text style={{ ...type.caption, color: t.ink3, marginTop: 1 }} numberOfLines={1}>{e.sub}</Text>
              </View>
              <View pointerEvents="none">
                <DesignIcon.chev size={SMALL_GLYPH} color={t.ink4} />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </>
  );

  // Morgen / Middag / Aften brief-history shortcuts row.
  const timeOfDaySection = (
    <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }}>
      {(['morning', 'midday', 'evening'] as const).map((kind) => {
        const I = kind === 'morning' ? Sunrise : kind === 'midday' ? Sun : Moon;
        const label = kind === 'morning' ? 'Morgen' : kind === 'midday' ? 'Middag' : 'Aften';
        return (
          <Pressable
            key={kind}
            onPress={() => setHistoryKind(kind)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Tidligere ${label.toLowerCase()}briefs`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm - 2,
              paddingVertical: spacing.sm - 2,
              paddingHorizontal: spacing.md,
            }}
          >
            <I size={SMALL_GLYPH} color={t.ink2} strokeWidth={1.75} />
            <Text style={{ ...type.caption, color: t.ink2, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  // Divider between sections inside the unified quiet-state card.
  const sectionDivider = (
    <View style={{ height: 1, backgroundColor: t.line, marginVertical: spacing.md }} />
  );

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(e) => {
          viewportHRef.current = e.nativeEvent.layout.height;
          checkOverDark();
        }}
      >
        {/* TopBar */}
        <TopBar
          eyebrow={dateInfo.eyebrow.toUpperCase()}
          onBell={onOpenNotifications}
          onGear={onGoToSettings}
        />

        {/* Hero text block - bone-white backdrop so the headline reads
            crisply against the halo paper. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
            <Text style={{ ...type.displayM, color: t.ink }}>
              {user ? `${hello}, ${user.name}.` : `${hello}.`}
            </Text>
            {authUser ? (
              <Text style={{ ...type.body, color: t.ink2, marginTop: spacing.md - 2, maxWidth: 300 }}>
                <CountUp to={todayMeetingCount} /> {todayMeetingCount === 1 ? 'møde' : 'møder'},{' '}
                <CountUp to={inboxCounts.unread} /> {inboxCounts.unread === 1 ? 'mail venter' : 'mails venter'},
                og <CountUp to={pendingReminders.length} /> {pendingReminders.length === 1 ? 'påmindelse' : 'påmindelser'}.
              </Text>
            ) : (
              // Logged-out subtitle: subtle CTA replacing the empty stats so
              // the hero block carries an actionable next step instead of
              // "0 møder, 0 mails" - which would just look like a bug.
              <TouchableOpacity
                onPress={onGoToSettings}
                accessibilityRole="button"
                accessibilityLabel="Log ind for at se din dag"
                style={{ marginTop: spacing.md - 2, alignSelf: 'flex-start' }}
              >
                <Text style={{ ...type.body, color: t.ink2 }}>
                  Log ind for at se din dag.{' '}
                  <Text style={{ color: t.ink, fontWeight: '600' }}>Log ind →</Text>
                </Text>
              </TouchableOpacity>
            )}
          </GlassFrostedCard>
        </View>

        {/* Frosted hero stat card - uses GlassFrostedCard so iOS 26+
            renders the native Liquid Glass material; older iOS / Android
            fall back to the BlurView+bone path inside the primitive. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            intensity={blur.hero}
            style={{ padding: spacing.screenPad }}
          >
              {/* Top eyebrow row: "LIGE NU" + clock */}
              <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: spacing.cardPad }}>
                <Text style={{ ...type.eyebrow, color: t.ink2, fontWeight: '600' }}>Lige nu</Text>
                <View style={{ flex: 1 }} />
                <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '500', textTransform: 'none' }}>
                  {`${today.getHours().toString().padStart(2, '0')}:${today.getMinutes().toString().padStart(2, '0')}`}
                </Text>
              </View>

              {/* Big number + secondary stats */}
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.lg }}>
                <View>
                  <CountUp
                    to={todayMeetingCount}
                    style={{
                      fontFamily: fonts.display,
                      fontSize: heroStat.bigSize,
                      lineHeight: heroStat.bigLineHeight,
                      fontWeight: '500',
                      letterSpacing: heroStat.bigLetterSpacing,
                      color: t.ink,
                    }}
                  />
                  <Text style={{ ...type.eyebrow, color: t.ink2, marginTop: spacing.xs, fontWeight: '600' }}>{todayMeetingCount === 1 ? 'Møde' : 'Møder'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', gap: spacing.cardPad }}>
                    <View>
                      <CountUp
                        to={inboxCounts.unread}
                        style={{
                          fontFamily: fonts.display,
                          fontSize: heroStat.midSize,
                          fontWeight: '500',
                          letterSpacing: heroStat.midLetterSpacing,
                          color: t.ink,
                        }}
                      />
                      <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: spacing.xs, fontWeight: '600' }}>{inboxCounts.unread === 1 ? 'Mail' : 'Mails'}</Text>
                    </View>
                    <View style={{ width: 1, backgroundColor: t.line }} />
                    <View>
                      <CountUp
                        to={pendingReminders.length}
                        style={{
                          fontFamily: fonts.display,
                          fontSize: heroStat.midSize,
                          fontWeight: '500',
                          letterSpacing: heroStat.midLetterSpacing,
                          color: t.ink,
                        }}
                      />
                      <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: spacing.xs, fontWeight: '600' }}>{pendingReminders.length === 1 ? 'Påmindelse' : 'Påmindelser'}</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Day ribbon - same data as the inline hero bar but each
                  block is tappable and expands to show title, time,
                  location, attendees, and description. Code already
                  lived in components/DayRibbon. */}
              <View style={{ marginTop: spacing.cardPad + 2 }}>
                <DayRibbon events={ribbonEvents} now={today} />
              </View>
          </GlassFrostedCard>
        </View>

        {/* iCloud expired banner */}
        {icloudExpired && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => onOpenIcloudSetup?.(icloudExpiredEmail ?? undefined)} accessibilityRole="button">
              <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Apple afviste adgangskoden - iCloud-begivenheder vises ikke. Tryk for at genindtaste.
                </Text>
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {/* Husk preview */}
        {showHuskPreview && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={onGoToMemory}>
              <GlassFrostedCard style={{ padding: spacing.cardPad, gap: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Bookmark size={SMALL_GLYPH} color={t.mem} strokeWidth={2} />
                  <Text style={{ ...type.eyebrow, color: t.mem, fontWeight: '700' }}>Husk</Text>
                  <Text style={{ ...type.eyebrow, color: t.ink3, flex: 1 }}>
                    {pendingReminders.length > 0 && plural(pendingReminders.length, 'påmindelse', 'påmindelser')}
                    {pendingReminders.length > 0 && notes.length > 0 && ' · '}
                    {notes.length > 0 && plural(notes.length, 'note', 'noter')}
                  </Text>
                  <DesignIcon.chev size={SMALL_GLYPH} color={t.ink4} />
                </View>
                {pendingReminders.slice(0, 2).map((r) => (
                  <HuskReminderLine key={r.id} reminder={r} now={today} />
                ))}
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {/* "Næste" section - bone-white backdrop card hosting the
            section header + the events list (or empty state). */}
        {/* BriefBanner — transient, kept above the unified quiet-state card. */}
        {brief && !brief.readAt && (
          <BriefBanner
            brief={brief}
            onOpen={() => setViewingBrief(brief)}
            onDismiss={() => {
              void markBriefRead();
            }}
          />
        )}

        {/* Open loops entry — only shown when the agent is tracking something.
            Kept as its own card above the unified card. Tapping opens the
            read-only OpenLoopsModal (mounted outside the ScrollView below). */}
        {openLoops.length > 0 && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.md }}>
            <Pressable
              onPress={() => setShowOpenLoops(true)}
              accessibilityLabel="Åbne loops"
              accessibilityRole="button"
            >
              <GlassFrostedCard style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <Stone mood="thinking" size={34} jumpOnTap={false} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ ...type.body, color: t.ink, fontWeight: '600' }}>Åbne loops</Text>
                    <Text style={{ ...type.caption, color: t.ink3 }}>
                      {openLoops.length === 1 ? '1 tråd jeg holder øje med' : `${openLoops.length} tråde jeg holder øje med`}
                    </Text>
                  </View>
                  <Text style={{ ...type.body, color: t.ink3 }}>›</Text>
                </View>
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {/* Unified quiet-state card: Næste + agent feed (inline) + the
            Morgen/Middag/Aften row read as ONE card. The agent feed reports
            its empty state via onEmpty; whether empty or full it renders flush
            inside this single card. */}
        <View
          style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}
          accessibilityLabel={agentEmpty ? 'today-quiet-card' : 'today-active-card'}
        >
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
            {naesteSection}
            {sectionDivider}
            <TodayAgentFeed
              embedded
              onEmpty={setAgentEmpty}
              onSelectProposal={setSelectedProposal}
              onSelectAction={setSelectedAction}
            />
            {sectionDivider}
            {timeOfDaySection}
          </GlassFrostedCard>
        </View>

        {/* Modals */}
        <BriefModal
          brief={viewingBrief}
          visible={viewingBrief !== null}
          onClose={() => {
            const wasTodayUnread =
              viewingBrief !== null && brief !== null && viewingBrief.id === brief.id && !brief.readAt;
            setViewingBrief(null);
            // Mark read when the user has seen today's unread brief.
            if (wasTodayUnread) void markBriefRead();
          }}
        />
        <BriefHistoryModal
          kind={historyKind}
          onClose={() => setHistoryKind(null)}
          onSelect={(b) => {
            setViewingBrief(b);
            setHistoryKind(null);
          }}
        />
        <ObservationHistoryModal
          visible={observationHistoryOpen}
          onClose={() => setObservationHistoryOpen(false)}
        />

        {/* Observation card - light, airbrushy, blends with the rest of
            the app rather than being a dark slab. The chrome no longer
            needs to flip dark when scrolled into this region. */}
        <View
          style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.xl, paddingBottom: chromeBottom + spacing.xl }}
        >
          <GlassFrostedCard style={{ padding: spacing.screenPad }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.cardPad }}>
              <Text style={{ ...type.title, fontFamily: fonts.display, color: t.ink }}>
                Hvad jeg har bemærket
              </Text>
              <Pressable
                onPress={() => setObservationHistoryOpen(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Tidligere observationer"
              >
                <Text style={{ ...type.caption, color: t.ink3, fontWeight: '600' }}>Tidligere</Text>
              </Pressable>
            </View>

            {pendingFacts.length === 0 && visibleObservations.length === 0 ? (
              observationsError ? (
                <EmptyState
                  mood="thinking"
                  title="Kunne ikke hente observationer"
                  body="Jeg kan ikke nå min AI lige nu. Prøv igen om lidt."
                />
              ) : hasProvider ? (
                <EmptyState
                  mood="thinking"
                  title="Intet at fremhæve lige nu"
                  body="Jeg kigger på dagens kalender og indbakke og fremhæver det vigtigste. Tjek tilbage når der er noget nyt."
                />
              ) : (
                <EmptyState
                  mood="thinking"
                  title="Intet at fortælle endnu"
                  body="Når jeg har adgang til din indbakke og kalender, samler jeg observationer her."
                  ctaLabel="Forbind konti"
                  onCta={onGoToSettings}
                />
              )
            ) : (
              <View style={{ gap: 14 }}>
                {feedFacts.map((f) => (
                  <PendingFactRow
                    light
                    key={f.id}
                    fact={f}
                    onAccept={() => acceptFact(f.id)}
                    onReject={() => rejectFactHook(f.id)}
                  />
                ))}
                {feedObservations.map((n, i) => (
                  <NoticedRow
                    light
                    key={n.id}
                    item={n}
                    index={i}
                    onAction={() => {
                      // Acting on an observation implicitly resolves it -
                      // dismiss before handing off so the card disappears
                      // immediately and doesn't sit there waiting for the
                      // user to come back and explicitly Afvis.
                      dismissObservation(n.id);
                      handleObservationAction(n.action, n);
                    }}
                    onDismiss={() => dismissObservation(n.id)}
                  />
                ))}
                {hasMoreObservations && (
                  <Pressable
                    onPress={() => setObservationsModalOpen(true)}
                    style={styles.showAllRowLight}
                    hitSlop={8}
                  >
                    <Text style={styles.showAllTextLight}>
                      Vis alle ({dedupedObservations.length}) →
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </GlassFrostedCard>
        </View>

        {/* "Vis alle" observations modal */}
        <Modal
          visible={observationsModalOpen}
          animationType="slide"
          presentationStyle="overFullScreen"
          transparent
          onRequestClose={() => setObservationsModalOpen(false)}
        >
          <View style={styles.modalRoot}>
            <GlassHaloLayer />
            <SafeAreaView style={{ flex: 1 }}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Hvad jeg har bemærket</Text>
                <Pressable
                  onPress={() => setObservationsModalOpen(false)}
                  hitSlop={12}
                  style={styles.modalClose}
                >
                  <X size={18} color={colors.ink} strokeWidth={1.75} />
                </Pressable>
              </View>
              <ScrollView
                contentContainerStyle={styles.modalBody}
                showsVerticalScrollIndicator={false}
              >
                {dedupedObservations.length === 0 ? (
                  <Text style={styles.modalEmpty}>Ingen flere observationer lige nu.</Text>
                ) : (
                  dedupedObservations.map((n, i) => (
                    <GlassFrostedCard key={n.id} style={styles.modalRowCardInner}>
                      <NoticedRow
                        light
                        item={n}
                        index={i}
                        onAction={() => {
                          // Same implicit dismissal as the feed call site -
                          // tapping the CTA means the user resolved this
                          // observation, so don't make them dismiss twice.
                          dismissObservation(n.id);
                          setObservationsModalOpen(false);
                          handleObservationAction(n.action, n);
                        }}
                        onDismiss={() => dismissObservation(n.id)}
                      />
                    </GlassFrostedCard>
                  ))
                )}
              </ScrollView>
            </SafeAreaView>
          </View>
        </Modal>
      </ScrollView>

      {/* ProposalDetailModal — mounted OUTSIDE the ScrollView so the
          Animated.View overlay is never clipped by the scroll container.
          Pattern matches MemoryConsentModal: absoluteFill Animated.View
          with zIndex, mounted in the root <View style={{ flex:1, position:'relative' }}> */}
      {selectedProposal ? (
        <ProposalDetailModal
          row={selectedProposal}
          onClose={() => setSelectedProposal(null)}
        />
      ) : null}

      {selectedAction ? (
        <AgentActionDetailModal
          row={selectedAction}
          onClose={() => setSelectedAction(null)}
        />
      ) : null}

      {showOpenLoops ? (
        <OpenLoopsModal rows={openLoops} onClose={() => setShowOpenLoops(false)} />
      ) : null}
    </View>
  );
}

function HuskReminderLine({ reminder, now }: { reminder: Reminder; now: Date }) {
  const dueAt = reminder.dueAt;
  let timeLabel: string;
  if (!dueAt) {
    timeLabel = 'Ingen tid';
  } else {
    const time = `${dueAt.getHours().toString().padStart(2, '0')}.${dueAt.getMinutes().toString().padStart(2, '0')}`;
    const sameDay =
      dueAt.getFullYear() === now.getFullYear() &&
      dueAt.getMonth() === now.getMonth() &&
      dueAt.getDate() === now.getDate();
    timeLabel = sameDay ? time : `${dueAt.getDate()}.${dueAt.getMonth() + 1}`;
  }
  return (
    <View style={styles.huskLine}>
      <Text style={styles.huskTime}>{timeLabel}</Text>
      <Text style={styles.huskText} numberOfLines={1}>{reminder.text}</Text>
    </View>
  );
}

function NoticedRow({
  item,
  index,
  onAction,
  onDismiss,
  light,
}: {
  item: Observation;
  index: number;
  onAction: () => void;
  onDismiss: () => void;
  // When true, render with ink text + sage accent suitable for a light
  // background (e.g. the airbrushy "Vis alle" modal). Default is the
  // legacy dark styling used on the inline glass-dark card.
  light?: boolean;
}) {
  // Reanimated handles entrance, exit, and neighbor reflow for free.
  // When the parent removes this row from its data array, exiting={FadeOut}
  // animates this view out while layout={LinearTransition} slides the
  // remaining rows up smoothly into the freed space - no manual animateOut.
  return (
    <Animated.View
      entering={FadeIn.duration(420).delay(index * 100)}
      exiting={FadeOut.duration(220)}
      layout={LinearTransition.duration(260)}
      style={styles.noticedRow}
    >
      <Stone mood={item.mood} size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.noticedText, light && styles.noticedTextLight]}>{item.text}</Text>
        <View style={styles.noticedActions}>
          <Pressable
            onPress={onAction}
            hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
            style={({ pressed }) => [styles.noticedActionHit, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedCta, light && styles.noticedCtaLight]}>{item.cta} →</Text>
          </Pressable>
          <Pressable
            onPress={onDismiss}
            hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
            style={({ pressed }) => [styles.noticedActionHit, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedDismiss, light && styles.noticedDismissLight]}>Afvis</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

function PendingFactRow({
  fact,
  onAccept,
  onReject,
  light,
}: {
  fact: Fact;
  onAccept: () => void;
  onReject: () => void;
  light?: boolean;
}) {
  return (
    <Animated.View
      entering={FadeIn.duration(420)}
      exiting={FadeOut.duration(220)}
      layout={LinearTransition.duration(260)}
      style={styles.noticedRow}
    >
      <Stone mood="thinking" size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.noticedText, light && styles.noticedTextLight]}>Skal jeg huske at {fact.text}?</Text>
        <View style={styles.noticedActions}>
          <Pressable
            onPress={onAccept}
            hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
            style={({ pressed }) => [styles.noticedActionHit, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedCta, light && styles.noticedCtaLight]}>Ja, husk det</Text>
          </Pressable>
          <Pressable
            onPress={onReject}
            hitSlop={{ top: 10, bottom: 10, left: 0, right: 0 }}
            style={({ pressed }) => [styles.noticedActionHit, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedDismiss, light && styles.noticedDismissLight]}>Nej</Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1 },

  // Sub-component styles (HuskReminderLine)
  huskLine: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  huskTime: {
    fontFamily: legacyFonts.mono, fontSize: 11, color: colors.sageDeep,
    minWidth: 42,
  },
  huskText: { flex: 1, fontFamily: legacyFonts.ui, fontSize: 13, color: colors.ink },

  // Observation rows (NoticedRow / PendingFactRow)
  noticedRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  noticedText: { fontFamily: legacyFonts.ui, fontSize: 14.5, lineHeight: 21, color: colors.paperOn95 },
  noticedActions: { marginTop: 4, flexDirection: 'row', gap: 16 },
  // Per-button wrapper. paddingVertical + paddingHorizontal extend the
  // visible tap area; negative margins keep the surrounding layout
  // unchanged. Horizontal hitSlop is intentionally zero - the gap between
  // CTA and Afvis is only 16px, and slop on both sides would make the hit
  // zones overlap, leading to ambiguous taps. Vertical hitSlop adds the
  // extra forgiveness needed to clear the 44pt iOS minimum.
  noticedActionHit: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    marginVertical: -8,
    marginHorizontal: -4,
  },
  noticedActionPressed: { opacity: 0.55 },
  // Primary CTA reads in ink (dark) on both light and dark backdrops -
  // the user wanted a single emphatic black tone here rather than a sage
  // accent that could blend with the halo.
  noticedCta: { fontFamily: legacyFonts.uiSemi, fontSize: 14, color: colors.paperOn95 },
  noticedCtaLight: { color: colors.ink },
  noticedDismiss: { fontFamily: legacyFonts.ui, fontSize: 14, color: colors.paperOn50 },

  // "Vis alle" row inside dark card
  showAllRow: {
    marginTop: 6,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.paperOn20,
    alignItems: 'flex-start',
  },
  showAllText: {
    fontFamily: legacyFonts.uiSemi,
    fontSize: 13,
    letterSpacing: 0.2,
    color: colors.sageDim,
  },
  // Light-card variant - used inside the airbrushy "Hvad jeg har
  // bemærket" card now that it sits on the regular paper backdrop.
  showAllRowLight: {
    marginTop: 6,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
    alignItems: 'flex-start',
  },
  showAllTextLight: {
    fontFamily: legacyFonts.uiSemi,
    fontSize: 13,
    letterSpacing: 0.2,
    color: colors.sage,
  },

  // Light variant of the noticed row used inside the airbrushy "Vis alle"
  // modal - ink text reads against the light backdrop instead of the
  // legacy white-on-dark used by the inline glass-dark card.
  noticedTextLight: { color: colors.ink },
  noticedDismissLight: { color: colors.fg3 },

  // "Vis alle" observations modal - light, airbrushy, blends with the rest
  // of the app instead of a black slab popping out on top.
  modalRoot: { flex: 1, backgroundColor: '#FBFBFA', overflow: 'hidden' },
  modalHandle: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.18)',
    marginTop: 8,
    marginBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  modalTitle: {
    fontFamily: legacyFonts.display,
    fontSize: 22,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  modalClose: {
    width: 32,
    height: 32,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  modalBody: { padding: 20, gap: 12, paddingBottom: 40 },
  modalRowCardInner: { padding: 14 },
  modalEmpty: {
    fontFamily: legacyFonts.ui,
    fontSize: 14,
    lineHeight: 21,
    color: colors.fg3,
    textAlign: 'center',
    paddingVertical: 40,
  },
});
