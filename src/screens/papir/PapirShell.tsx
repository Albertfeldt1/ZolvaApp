import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Dimensions, PanResponder, StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  SlideInRight,
  SlideInDown,
  SlideOutDown,
  SlideOutRight,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { papirColor, papirDuration } from '../../design/papir';
import { TabVisibilityProvider } from '../../lib/tab-visibility';
import {
  consumePapirRoute,
  PapirNavProvider,
  subscribePapirRoute,
  type PushEntry,
  type PushParams,
  type PushScreen,
} from './nav';
import { PapirRecord } from './PapirRecord';
import { PapirTranscription } from './PapirTranscription';
import { PapirHome } from './PapirHome';
import { PapirPlan } from './PapirPlan';
import { PapirHistory } from './PapirHistory';
import { PapirProfile } from './PapirProfile';
import { PapirBriefing } from './PapirBriefing';
import { PapirChat } from './PapirChat';
import { PapirSearch } from './PapirSearch';
import { PapirSettings } from './PapirSettings';
import { PapirAgent } from './PapirAgent';
import { PapirInbox } from './PapirInbox';
import { PapirNotifications } from './PapirNotifications';
import { PapirMailDetail } from './PapirMailDetail';
import { PapirNoteDetail } from './PapirNoteDetail';
import { PapirSentMails } from './PapirSentMails';
import { PapirSignature } from './PapirSignature';
import { PapirNetwork } from './PapirNetwork';
import { PapirNetworkDetail } from './PapirNetworkDetail';
import { NetworkToast } from './NetworkToast';
import { PapirBottomNav, type PapirTab } from './PapirBottomNav';

function PushView({ screen, params }: { screen: PushScreen; params?: PushParams }) {
  switch (screen) {
    case 'briefing':
      return <PapirBriefing />;
    case 'chat':
      return <PapirChat />;
    case 'search':
      return <PapirSearch />;
    case 'settings':
      return <PapirSettings />;
    case 'inbox':
      return <PapirInbox />;
    case 'mailDetail':
      return <PapirMailDetail params={params ?? {}} />;
    case 'agent':
      return <PapirAgent />;
    case 'notifications':
      return <PapirNotifications />;
    case 'signature':
      return <PapirSignature />;
    case 'noteDetail':
      return <PapirNoteDetail id={params?.id} />;
    case 'sentMails':
      return <PapirSentMails />;
    case 'network':
      return <PapirNetwork />;
    case 'networkPerson':
      return <PapirNetworkDetail personId={params?.personId} />;
  }
}

/** Kant-swipe-back på push-skærme (M13): venstre-kant-pan følger fingeren og
 * popper stakken ved slip forbi tærsklen — ellers fjedrer laget tilbage.
 * PanResponder (ikke gesture-handler) så vi ikke tilføjer et native-modul;
 * shared value opdateres fra JS, hvilket er rigeligt til en kantswipe. */
const EDGE_WIDTH = 36;

function PushLayer({
  topMost,
  canPopNow,
  pop,
  children,
}: {
  topMost: boolean;
  /** Konsulterer back-guarden (mail-kladde H6). False = guarden viser sin egen confirm. */
  canPopNow: () => boolean;
  pop: () => void;
  children: React.ReactNode;
}) {
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  // Refs så responderen (skabt én gang) altid ser friske props.
  const topMostRef = useRef(topMost);
  topMostRef.current = topMost;
  const canPopRef = useRef(canPopNow);
  canPopRef.current = canPopNow;
  const popRef = useRef(pop);
  popRef.current = pop;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, gs) =>
          topMostRef.current && gs.x0 < EDGE_WIDTH && gs.dx > 10 && Math.abs(gs.dy) < Math.abs(gs.dx),
        onPanResponderMove: (_e, gs) => {
          x.value = Math.max(0, gs.dx);
        },
        onPanResponderRelease: (_e, gs) => {
          const w = Dimensions.get('window').width;
          const shouldPop = gs.dx > w * 0.3 || gs.vx > 0.8;
          if (shouldPop && canPopRef.current()) {
            x.value = withTiming(w, { duration: 160 }, (finished) => {
              'worklet';
              if (finished) runOnJS(popRef.current)();
            });
          } else {
            x.value = withTiming(0, { duration: 180 });
          }
        },
        onPanResponderTerminate: () => {
          x.value = withTiming(0, { duration: 180 });
        },
      }),
    [x],
  );

  return (
    <Animated.View
      entering={SlideInRight.duration(papirDuration.pushIn)}
      exiting={SlideOutRight.duration(papirDuration.pushIn - 100)}
      style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 70 }, style]}
      {...responder.panHandlers}
    >
      {children}
    </Animated.View>
  );
}

const TABS: { key: PapirTab; Screen: React.ComponentType }[] = [
  { key: 'home', Screen: PapirHome },
  { key: 'plan', Screen: PapirPlan },
  { key: 'history', Screen: PapirHistory },
  { key: 'profile', Screen: PapirProfile },
];

type Recording = { uri: string; durationMillis: number };

/** Papir shell: keep-alive tab panes + a real push stack + the voice overlays. */
export function PapirShell({ openAuth }: { openAuth?: () => void }) {
  const [tab, setTab] = useState<PapirTab>('home');
  // Tabs mount on first visit and stay alive (same pattern as App.tsx's
  // mountedTabs) so scroll position and local state survive switching.
  const [mountedTabs, setMountedTabs] = useState<PapirTab[]>(['home']);
  const [stack, setStack] = useState<PushEntry[]>([]);
  const pushSeq = useRef(0);
  // Voice flow: full-screen recorder, then a transcription screen for the take.
  const [recording, setRecording] = useState(false);
  const [transcribe, setTranscribe] = useState<Recording | null>(null);

  // Content-initiated tab switches (Home shortcuts, "Se alle" links) slide
  // the pane in from the right so they read like the push screens they sit
  // next to; bottom-nav switches stay instant. The panes are keep-alive, so
  // this is an imperative one-shot on a shared value — an `entering`
  // animation would only fire on first mount.
  const paneSlideX = useSharedValue(0);
  const paneSlideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: paneSlideX.value }] }));
  // The tab we're sliding AWAY from stays visible beneath the incoming pane
  // for the duration — exactly like a push slides over the still-visible
  // screen. Without this the slide reveals blank paper, which reads wrong.
  const [slideUnderlay, setSlideUnderlay] = useState<PapirTab | null>(null);
  const slideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (slideTimer.current) clearTimeout(slideTimer.current);
  }, []);

  const selectTab = useCallback(
    (t: PapirTab, opts?: { slide?: boolean }) => {
      setMountedTabs((m) => (m.includes(t) ? m : [...m, t]));
      if (opts?.slide && t !== tab) {
        // EXACTLY the push-screen transition (SlideInRight.duration(pushIn)):
        // same distance (window width), same duration, and withTiming's
        // default easing — SlideInRight sets no explicit easing, so a custom
        // curve here would make the two feel different.
        setSlideUnderlay(tab);
        if (slideTimer.current) clearTimeout(slideTimer.current);
        slideTimer.current = setTimeout(() => setSlideUnderlay(null), papirDuration.pushIn + 50);
        paneSlideX.value = Dimensions.get('window').width;
        paneSlideX.value = withTiming(0, { duration: papirDuration.pushIn });
      }
      setTab(t);
    },
    [tab, paneSlideX],
  );

  // Unsaved-state guard for hardware back (H6) — see nav.setBackGuard.
  const backGuardRef = useRef<(() => boolean) | null>(null);

  const nav = useMemo(
    () => ({
      push: (s: PushScreen, params?: PushParams) => {
        pushSeq.current += 1;
        setStack((st) => [...st, { key: `${s}-${pushSeq.current}`, screen: s, params }]);
      },
      back: () => setStack((st) => st.slice(0, -1)),
      setTab: (t: PapirTab, opts?: { slide?: boolean }) => {
        // Navigating to a tab from a pushed screen implies leaving the stack.
        setStack([]);
        selectTab(t, opts);
      },
      openAuth: openAuth ?? (() => {}),
      setBackGuard: (guard: (() => boolean) | null) => {
        backGuardRef.current = guard;
      },
    }),
    [openAuth, selectTab],
  );

  // Ruter fra App.tsx (notifikationstryk / deep links): forbrug ved mount
  // (koldstart-tryk kan ligge og vente) og lyt derefter live. Et tryk er en
  // eksplicit destination, så voice-flow og push-stak forlades først.
  useEffect(() => {
    const apply = () => {
      const req = consumePapirRoute();
      if (!req) return;
      setRecording(false);
      setTranscribe(null);
      if (req.kind === 'tab') {
        nav.setTab(req.tab);
      } else {
        setStack([]);
        nav.push(req.screen, req.params);
      }
    };
    apply();
    return subscribePapirRoute(apply);
  }, [nav]);

  // Android hardware back: recorder → transcription → push stack → home tab →
  // default (minimize). Ordering matters: never minimize mid-recording.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (recording) {
        setRecording(false);
        return true;
      }
      if (transcribe) {
        setTranscribe(null);
        return true;
      }
      if (stack.length > 0) {
        // A screen with unsaved state (mail draft) gets to intercept (H6).
        if (backGuardRef.current?.()) return true;
        setStack((st) => st.slice(0, -1));
        return true;
      }
      if (tab !== 'home') {
        selectTab('home');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [recording, transcribe, stack.length, tab, selectTab]);

  return (
    <PapirNavProvider value={nav}>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        {TABS.filter((t) => mountedTabs.includes(t.key)).map(({ key, Screen }) => {
          const active = tab === key;
          const underlay = slideUnderlay === key;
          // Stacking is render-order based (no zIndex — that would fight the
          // bottom nav): slides start from Home, TABS[0], so the incoming
          // pane always renders later and lands on top of the underlay.
          return (
            <Animated.View
              key={key}
              style={[
                StyleSheet.absoluteFill,
                { display: active || underlay ? 'flex' : 'none', backgroundColor: papirColor.paper },
                active ? paneSlideStyle : null,
              ]}
              pointerEvents={active ? 'auto' : 'none'}
            >
              {/* Hidden panes pause their periodic timers via this flag —
                  see lib/tab-visibility.ts. */}
              <TabVisibilityProvider value={active}>
                <Screen />
              </TabVisibilityProvider>
            </Animated.View>
          );
        })}
        <PapirBottomNav active={tab} onChange={selectTab} onRecord={() => setRecording(true)} />

        {/* Push stack: each entry is its own keyed layer so push-over-push
            animates in and back pops just the top screen. */}
        {stack.map((entry, idx) => (
          <PushLayer
            key={entry.key}
            topMost={idx === stack.length - 1}
            canPopNow={() => backGuardRef.current?.() !== true}
            pop={() => setStack((st) => st.slice(0, -1))}
          >
            <PushView screen={entry.screen} params={entry.params} />
          </PushLayer>
        ))}

        {/* Transcription screen for a captured recording */}
        {transcribe ? (
          <Animated.View
            entering={SlideInRight.duration(papirDuration.pushIn)}
            exiting={SlideOutRight.duration(papirDuration.pushIn - 100)}
            style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 75 }]}
          >
            <PapirTranscription
              uri={transcribe.uri}
              durationMillis={transcribe.durationMillis}
              onDone={() => setTranscribe(null)}
            />
          </Animated.View>
        ) : null}

        {/* Netværks-ekstraktionen fra gemte talenoter lander efter
            transskriptions-skærmen er lukket — toasten er den eneste synlige
            bekræftelse. Chat-turene håndterer PapirChat selv. */}
        <NetworkToast />

        {/* Full-screen recorder overlay (slides up from the bottom) */}
        {recording ? (
          <Animated.View
            entering={SlideInDown.duration(papirDuration.overlay)}
            exiting={SlideOutDown.duration(papirDuration.overlay - 100)}
            style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 80 }]}
          >
            <PapirRecord
              onStop={(uri, durationMillis) => {
                setRecording(false);
                setTranscribe({ uri, durationMillis });
              }}
              onClose={() => setRecording(false)}
            />
          </Animated.View>
        ) : null}
      </View>
    </PapirNavProvider>
  );
}
