import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import Animated, { SlideInRight, SlideInDown, SlideOutDown, SlideOutRight } from 'react-native-reanimated';
import { papirColor, papirDuration } from '../../design/papir';
import { PapirNavProvider, type PushEntry, type PushParams, type PushScreen } from './nav';
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
import { PapirInbox } from './PapirInbox';
import { PapirBottomNav, type PapirTab } from './PapirBottomNav';

function PushView({ screen }: { screen: PushScreen; params?: PushParams }) {
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
      // Wired in M4 (PapirMailDetail). Until then an accidental push is a no-op screen.
      return null;
  }
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

  const selectTab = useCallback((t: PapirTab) => {
    setMountedTabs((m) => (m.includes(t) ? m : [...m, t]));
    setTab(t);
  }, []);

  const nav = useMemo(
    () => ({
      push: (s: PushScreen, params?: PushParams) => {
        pushSeq.current += 1;
        setStack((st) => [...st, { key: `${s}-${pushSeq.current}`, screen: s, params }]);
      },
      back: () => setStack((st) => st.slice(0, -1)),
      setTab: (t: PapirTab) => {
        // Navigating to a tab from a pushed screen implies leaving the stack.
        setStack([]);
        selectTab(t);
      },
      openAuth: openAuth ?? (() => {}),
    }),
    [openAuth, selectTab],
  );

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
        {TABS.filter((t) => mountedTabs.includes(t.key)).map(({ key, Screen }) => (
          <View
            key={key}
            style={[StyleSheet.absoluteFill, { display: tab === key ? 'flex' : 'none' }]}
            pointerEvents={tab === key ? 'auto' : 'none'}
          >
            <Screen />
          </View>
        ))}
        <PapirBottomNav active={tab} onChange={selectTab} onRecord={() => setRecording(true)} />

        {/* Push stack: each entry is its own keyed layer so push-over-push
            animates in and back pops just the top screen. */}
        {stack.map((entry) => (
          <Animated.View
            key={entry.key}
            entering={SlideInRight.duration(papirDuration.pushIn)}
            exiting={SlideOutRight.duration(papirDuration.pushIn - 100)}
            style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 70 }]}
          >
            <PushView screen={entry.screen} params={entry.params} />
          </Animated.View>
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
