import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { SlideInRight, SlideInDown, SlideOutDown, SlideOutRight } from 'react-native-reanimated';
import { papirColor, papirDuration } from '../../design/papir';
import { PapirNavProvider, type PushScreen } from './nav';
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

function PushView({ screen }: { screen: PushScreen }) {
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
  }
}

/** Papir preview shell: tab screens + a right-sliding push stack on top. */
export function PapirShell() {
  const [tab, setTab] = useState<PapirTab>('home');
  const [pushed, setPushed] = useState<PushScreen | null>(null);
  // Voice flow: 'recording' → full-screen recorder; then a transcription screen
  // for the captured uri ('' = demo with no audio).
  const [recording, setRecording] = useState(false);
  const [transcribeUri, setTranscribeUri] = useState<string | null>(null);
  const nav = useMemo(() => ({ push: (s: PushScreen) => setPushed(s), back: () => setPushed(null) }), []);

  return (
    <PapirNavProvider value={nav}>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        {tab === 'home' ? (
          <PapirHome />
        ) : tab === 'plan' ? (
          <PapirPlan />
        ) : tab === 'history' ? (
          <PapirHistory />
        ) : (
          <PapirProfile />
        )}
        <PapirBottomNav active={tab} onChange={setTab} onRecord={() => setRecording(true)} />
        {pushed ? (
          <Animated.View
            entering={SlideInRight.duration(papirDuration.pushIn)}
            exiting={SlideOutRight.duration(papirDuration.pushIn - 100)}
            style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 70 }]}
          >
            <PushView screen={pushed} />
          </Animated.View>
        ) : null}

        {/* Transcription screen for a captured recording */}
        {transcribeUri !== null ? (
          <Animated.View
            entering={SlideInRight.duration(papirDuration.pushIn)}
            exiting={SlideOutRight.duration(papirDuration.pushIn - 100)}
            style={[StyleSheet.absoluteFill, { backgroundColor: papirColor.paper, zIndex: 75 }]}
          >
            <PapirTranscription uri={transcribeUri || null} onDone={() => setTranscribeUri(null)} />
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
              onStop={(uri) => {
                setRecording(false);
                setTranscribeUri(uri);
              }}
              onClose={() => setRecording(false)}
            />
          </Animated.View>
        ) : null}
      </View>
    </PapirNavProvider>
  );
}
