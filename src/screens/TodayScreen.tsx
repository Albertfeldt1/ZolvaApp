import { Bookmark, Moon, Sun, Sunrise, X } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth';
import { loadCredential } from '../lib/icloud-credentials';
import { BriefBanner } from '../components/BriefBanner';
import { CountUp } from '../components/CountUp';
import { BriefHistoryModal } from '../components/BriefHistoryModal';
import { BriefModal } from '../components/BriefModal';
import { ObservationHistoryModal } from '../components/ObservationHistoryModal';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { SkeletonRow } from '../components/Skeleton';
import type { Brief } from '../lib/briefs';
import { useTodayBrief } from '../lib/briefs';
import { formatToday, greeting } from '../lib/date';
import {
  useHasProvider,
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
  onOpenMail: (mail: InboxMail) => void;
  onGoToSettings: () => void;
  onGoToMemory: () => void;
  onOpenNotifications: () => void;
  onOverDarkChange?: (over: boolean) => void;
  // Incremented by App whenever a brief push is tapped — triggers the modal.
  briefOpenTrigger?: number;
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  // True when this tab is the visible one. Tabs stay mounted across switches,
  // so the screen needs an explicit signal to re-sync host chrome state when
  // it becomes active again.
  isActive?: boolean;
};

const PILL_CLEARANCE = 76;
// Small chevron / icon glyph size used inside cards.
const SMALL_GLYPH = 14;

export function TodayScreen({
  onOpenChat,
  onOpenChatWithPrompt,
  onOpenMail,
  onGoToSettings,
  onGoToMemory,
  onOpenNotifications,
  onOverDarkChange,
  briefOpenTrigger,
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
  const { data: reminders } = useReminders();
  const { data: notes } = useNotes();
  const hasProvider = useHasProvider();
  const { data: pendingFacts, accept: acceptFact, reject: rejectFactHook } = usePendingFacts();
  const { brief, markRead: markBriefRead } = useTodayBrief();
  const [viewingBrief, setViewingBrief] = useState<Brief | null>(null);
  const [historyKind, setHistoryKind] = useState<'morning' | 'midday' | 'evening' | null>(null);
  const [observationHistoryOpen, setObservationHistoryOpen] = useState(false);

  // Notification taps: App.tsx bumps briefOpenTrigger — we open the modal
  // if we have a brief to show.
  useEffect(() => {
    if (briefOpenTrigger && briefOpenTrigger > 0 && brief) {
      setViewingBrief(brief);
    }
  }, [briefOpenTrigger, brief]);

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
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
      // Prompt actions are agentic — the AI is expected to execute via its
      // tools. Auto-send so the user doesn't have to tap a second time.
      onOpenChatWithPrompt(action.prompt, { autoSend: true });
      return;
    }
    // openMail — search across both waiting AND read so a mail the user
    // already read still resolves. Without this, the action silently falls
    // through to chat as soon as the mail leaves the unread bucket, which
    // is what produced the inconsistent simulator-vs-phone behaviour.
    const mail =
      waiting.find((m) => m.id === action.mailId) ??
      readMails.find((m) => m.id === action.mailId);
    if (mail) {
      onOpenMail(mail);
      return;
    }
    // Mail isn't in either list — likely archived, dismissed, or the
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

  // The "Hvad jeg har bemærket" card caps the total displayed items —
  // pending facts + observations — at FEED_OBSERVATION_COUNT. Pending
  // facts go first (they need a user decision), then observations fill
  // any remaining slots. Anything past the cap is reachable via the
  // "Vis alle" modal.
  const FEED_OBSERVATION_COUNT = 4;
  const feedFacts = pendingFacts.slice(0, FEED_OBSERVATION_COUNT);
  const remainingSlots = Math.max(0, FEED_OBSERVATION_COUNT - feedFacts.length);
  const feedObservations = visibleObservations.slice(0, remainingSlots);
  const hasMoreObservations =
    pendingFacts.length + visibleObservations.length > FEED_OBSERVATION_COUNT;
  const [observationsModalOpen, setObservationsModalOpen] = useState(false);

  // Match the MemoryScreen filter: pending + dueAt within 5min past — so a
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
    return todayEvents
      .filter((e) => !e.allDay && e.start < endOfDay && e.end > startOfDay)
      .map((e) => ({
        id: e.id,
        startHour: toHour(e.start),
        endHour: toHour(e.end),
        title: e.title,
        start: e.start,
        end: e.end,
        color: e.color,
        location: e.location,
        description: e.description,
        attendees: e.attendees,
      }));
  }, [todayEvents, today]);

  // Hero-card soft ribbon — segments derived from real events on a
  // 6:00-22:00 visible window. Colors cycle through the direction's
  // signal palette so each event reads distinctly without needing
  // per-event tone classification.
  const ribbonSegments = useMemo(() => {
    const RIBBON_START = 6;
    const RIBBON_END = 22;
    const RIBBON_SPAN = RIBBON_END - RIBBON_START;
    const palette = [t.cal, t.today, t.mem, t.inbox];
    return ribbonEvents.slice(0, 4).map((e, i) => {
      const start = Math.max(RIBBON_START, e.startHour);
      const end = Math.min(RIBBON_END, e.endHour);
      const left = ((start - RIBBON_START) / RIBBON_SPAN) * 100;
      const width = Math.max(2, ((end - start) / RIBBON_SPAN) * 100);
      return {
        id: e.id,
        left: `${left}%` as const,
        width: `${width}%` as const,
        color: palette[i % palette.length],
      };
    });
  }, [ribbonEvents, t.cal, t.today, t.mem, t.inbox]);

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

        {/* Hero text block — bone-white backdrop so the headline reads
            crisply against the halo paper. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
            <Text style={{ ...type.displayXL, color: t.ink }}>
              {user ? `${hello},\n${user.name}.` : `${hello}.`}
            </Text>
            <Text style={{ ...type.body, color: t.ink2, marginTop: spacing.md - 2, maxWidth: 300 }}>
              <CountUp to={todayMeetingCount} /> {todayMeetingCount === 1 ? 'møde' : 'møder'},{' '}
              <CountUp to={waiting.length} /> {waiting.length === 1 ? 'mail venter' : 'mails venter'},
              og <CountUp to={pendingReminders.length} /> {pendingReminders.length === 1 ? 'påmindelse' : 'påmindelser'}.
            </Text>
          </GlassFrostedCard>
        </View>

        {/* Frosted hero stat card — uses GlassFrostedCard so iOS 26+
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
                  <Text style={{ ...type.eyebrow, color: t.ink2, marginTop: spacing.xs, fontWeight: '600' }}>Møder</Text>
                </View>
                <View style={{ flex: 1, paddingBottom: spacing.xs + 2 }}>
                  <View style={{ flexDirection: 'row', gap: spacing.cardPad }}>
                    <View>
                      <CountUp
                        to={waiting.length}
                        style={{
                          fontFamily: fonts.display,
                          fontSize: heroStat.midSize,
                          fontWeight: '500',
                          letterSpacing: heroStat.midLetterSpacing,
                          color: t.ink,
                        }}
                      />
                      <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: 2 }}>Mails</Text>
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
                      <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: 2 }}>Påmindelser</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Soft ribbon — segments derived from today's events */}
              <View
                style={{
                  marginTop: spacing.cardPad + 2,
                  height: heroStat.ribbonHeight,
                  borderRadius: radius.pill,
                  backgroundColor: surface.scrim,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {ribbonSegments.map((seg) => (
                  <View
                    key={seg.id}
                    style={{
                      position: 'absolute',
                      left: seg.left,
                      width: seg.width,
                      height: '100%',
                      backgroundColor: seg.color,
                      borderRadius: radius.pill,
                    }}
                  />
                ))}
              </View>
          </GlassFrostedCard>
        </View>

        {/* iCloud expired banner */}
        {icloudExpired && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => onOpenIcloudSetup?.(icloudExpiredEmail ?? undefined)} accessibilityRole="button">
              <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Apple afviste adgangskoden — iCloud-begivenheder vises ikke. Tryk for at genindtaste.
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

        {/* "Næste" section — bone-white backdrop card hosting the
            section header + the events list (or empty state). */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
          <GlassFrostedCard
            radius={radius.card}
            overlay={surface.bone}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
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
                {upcoming.length > 0 ? (<><CountUp to={upcoming.length} /> i dag</>) : '—'}
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
                  <View
                    key={e.id}
                    style={[
                      { flexDirection: 'row', alignItems: 'center', gap: spacing.cardPad, paddingVertical: spacing.md },
                      i > 0 && { borderTopWidth: 1, borderTopColor: t.line },
                    ]}
                  >
                    <View style={{ width: 6, alignSelf: 'stretch', borderRadius: radius.pill, backgroundColor: toneColor(e.tone) }} />
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                        <Text style={{ fontFamily: fonts.display, fontSize: type.title.fontSize - 2, fontWeight: '600', letterSpacing: -0.3, color: t.ink }}>{e.time}</Text>
                        <Text style={{ fontFamily: fonts.uiBold, fontSize: type.bodySm.fontSize, color: t.ink, flexShrink: 1 }} numberOfLines={1}>{e.title}</Text>
                      </View>
                      <Text style={{ ...type.caption, color: t.ink3, marginTop: 1 }} numberOfLines={1}>{e.sub}</Text>
                    </View>
                    <DesignIcon.chev size={SMALL_GLYPH} color={t.ink4} />
                  </View>
                ))}
              </View>
            )}
          </GlassFrostedCard>
        </View>

        {/* BriefBanner */}
        {brief && !brief.readAt && (
          <BriefBanner
            brief={brief}
            onOpen={() => setViewingBrief(brief)}
            onDismiss={() => {
              void markBriefRead();
            }}
          />
        )}

        {/* Brief history pills — wrapped in a single glass card so the
            three time-of-day shortcuts read as one element, not as
            three loose chips floating on the halo paper. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
          <GlassFrostedCard style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
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

        {/* Observation card — light, airbrushy, blends with the rest of
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
                    onAction={() => handleObservationAction(n.action, n)}
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
                      Vis alle ({visibleObservations.length}) →
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
          presentationStyle="pageSheet"
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
                {visibleObservations.length === 0 ? (
                  <Text style={styles.modalEmpty}>Ingen flere observationer lige nu.</Text>
                ) : (
                  visibleObservations.map((n, i) => (
                    <GlassFrostedCard key={n.id} style={styles.modalRowCardInner}>
                      <NoticedRow
                        light
                        item={n}
                        index={i}
                        onAction={() => {
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
  const fade = React.useRef(new Animated.Value(0)).current;
  const slide = React.useRef(new Animated.Value(8)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 600, delay: index * 120, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 600, delay: index * 120, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: true }),
    ]).start();
  }, [fade, slide, index]);

  const animateOut = (after: () => void) => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(slide, { toValue: -8, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start(after);
  };

  return (
    <Animated.View style={[styles.noticedRow, { opacity: fade, transform: [{ translateY: slide }] }]}>
      <Stone mood={item.mood} size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.noticedText, light && styles.noticedTextLight]}>{item.text}</Text>
        <View style={styles.noticedActions}>
          <Pressable
            onPress={onAction}
            hitSlop={8}
            style={({ pressed }) => [styles.noticedCtaBtn, light && styles.noticedCtaBtnLight, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedCtaBtnText, light && styles.noticedCtaBtnTextLight]}>{item.cta} →</Text>
          </Pressable>
          <Pressable
            onPress={() => animateOut(onDismiss)}
            hitSlop={12}
            style={({ pressed }) => [styles.noticedDismissBtn, pressed && styles.noticedActionPressed]}
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
    <View style={styles.noticedRow}>
      <Stone mood="thinking" size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.noticedText, light && styles.noticedTextLight]}>Skal jeg huske at {fact.text}?</Text>
        <View style={styles.noticedActions}>
          <Pressable
            onPress={onAccept}
            hitSlop={8}
            style={({ pressed }) => [styles.noticedCtaBtn, light && styles.noticedCtaBtnLight, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedCtaBtnText, light && styles.noticedCtaBtnTextLight]}>Ja, husk det</Text>
          </Pressable>
          <Pressable
            onPress={onReject}
            hitSlop={12}
            style={({ pressed }) => [styles.noticedDismissBtn, pressed && styles.noticedActionPressed]}
          >
            <Text style={[styles.noticedDismiss, light && styles.noticedDismissLight]}>Nej</Text>
          </Pressable>
        </View>
      </View>
    </View>
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
  noticedActions: { marginTop: 6, flexDirection: 'row', gap: 8, alignItems: 'center' },
  noticedActionPressed: { opacity: 0.55 },
  // Primary CTA — pill button with sage tint. paddingVertical:10 +
  // fontSize:14 lands the button height at ~38pt before the hitSlop:8
  // adds another 16pt of forgiveness, comfortably clearing the 44pt iOS
  // tap-target minimum. The visible bg makes the tap target obvious.
  noticedCtaBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: colors.sageSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(72,107,75,0.18)',
  },
  noticedCtaBtnLight: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.32)',
  },
  noticedCtaBtnText: { fontFamily: legacyFonts.uiSemi, fontSize: 14, color: colors.sageDeep },
  noticedCtaBtnTextLight: { color: colors.paper },
  // Secondary "Afvis"/"Nej" — text only with generous padding+hitSlop so
  // it stays easy to hit despite being visually subordinate.
  noticedDismissBtn: { paddingVertical: 10, paddingHorizontal: 8 },
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
  // Light-card variant — used inside the airbrushy "Hvad jeg har
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
  // modal — ink text reads against the light backdrop instead of the
  // legacy white-on-dark used by the inline glass-dark card.
  noticedTextLight: { color: colors.ink },
  noticedDismissLight: { color: colors.fg3 },

  // "Vis alle" observations modal — light, airbrushy, blends with the rest
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
