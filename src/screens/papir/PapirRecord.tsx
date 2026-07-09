import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, View } from 'react-native';
import { Pause, Play, X } from 'lucide-react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { deleteAsync } from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirShadow } from '../../design/papir';

type Props = {
  /** Called with the recorded file URI + duration when the user stops. */
  onStop: (uri: string, durationMillis: number) => void;
  onClose: () => void;
};

const BAR_COUNT = 34;
const BAR_MIN = 6;
const BAR_MAX = 84;
// Recorder-state poll — også waveformens fremdrift: hvert tick skubber ét
// nyt niveau ind fra højre, så vinduet ruller gennem de seneste ~3,4 s tale.
const METER_INTERVAL_MS = 100;

/** dB (typisk -160..0) → søjlehøjde. -50 dB regnes som stilhedsgulv; en let
 * kurve giver talens dynamik mere udsving end lineær mapping. */
function heightForDb(db: number | undefined): number {
  if (db == null || !Number.isFinite(db)) return BAR_MIN;
  const t = Math.min(1, Math.max(0, (db + 50) / 50));
  return BAR_MIN + Math.pow(t, 1.3) * (BAR_MAX - BAR_MIN);
}

/** Én søjle i den levende waveform (L4/L61): højden læses fra den delte
 * niveau-liste og animeres på UI-tråden — JS skriver kun listen 10×/sek. */
function WaveBar({ levels, index, paused }: { levels: SharedValue<number[]>; index: number; paused: boolean }) {
  const style = useAnimatedStyle(() => ({
    height: withTiming(paused ? BAR_MIN : levels.value[index], { duration: 90 }),
  }));
  return (
    <Animated.View style={[{ width: 3.5, borderRadius: 4, backgroundColor: papirColor.red }, style]} />
  );
}

/** Leave the iOS audio session in playback mode — recording mode mutes other
 * apps' audio and must never outlive this screen. Best-effort. */
function resetAudioMode(): void {
  setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
}

/** Full-screen record overlay: real expo-audio recording + live UI. */
export function PapirRecord({ onStop, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const state = useAudioRecorderState(recorder, METER_INTERVAL_MS);
  const [paused, setPaused] = useState(false);
  const levels = useSharedValue<number[]>(Array(BAR_COUNT).fill(BAR_MIN));
  const startedRef = useRef(false);
  const stoppingRef = useRef(false);

  // Request mic permission + start recording once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (cancelled) return;
        if (!perm.granted) {
          // Once denied, iOS never re-prompts — without a Settings link this
          // is a dead end (H10).
          Alert.alert('Mikrofon-adgang', 'Giv Zolva adgang til mikrofonen for at optage stemme-noter.', [
            { text: 'Ikke nu', style: 'cancel', onPress: onClose },
            {
              text: 'Åbn indstillinger',
              onPress: () => {
                Linking.openSettings().catch(() => {});
                onClose();
              },
            },
          ]);
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        if (cancelled) return;
        await recorder.prepareToRecordAsync();
        // The user may have hit Annullér while prepare was in flight — starting
        // now would leave a ghost recording behind the closed overlay.
        if (cancelled) {
          resetAudioMode();
          return;
        }
        recorder.record();
        startedRef.current = true;
      } catch (e) {
        console.warn('[voice] recorder start failed:', e instanceof Error ? e.message : String(e));
        if (!cancelled) {
          Alert.alert('Optagelse', 'Optagelsen kunne ikke startes. Prøv igen.');
          resetAudioMode();
          onClose();
        }
      }
    })();
    return () => {
      cancelled = true;
      // Unmount without an explicit stop (e.g. Android back): stop the native
      // recorder and restore the audio session. File cleanup happens in the
      // close path; after a normal stop the file is owned by transcription.
      if (startedRef.current && !stoppingRef.current) {
        stoppingRef.current = true;
        recorder.stop().catch(() => {}).finally(resetAudioMode);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Levende waveform drevet af det FAKTISKE lydniveau (L4): hvert
  // recorder-state-tick skubber det målte dB-niveau ind som ny søjle, så
  // brugeren kan se om mikrofonen fanger noget. Tidligere var søjlerne
  // Math.random()-dekoration, som kunne vildlede om optagekvaliteten.
  useEffect(() => {
    if (paused || !state.isRecording) return;
    levels.value = [...levels.value.slice(1), heightForDb(state.metering)];
  }, [state.metering, state.isRecording, paused, levels]);

  const togglePause = () => {
    if (!startedRef.current || stoppingRef.current) return;
    try {
      if (paused) {
        recorder.record();
        setPaused(false);
      } else {
        recorder.pause();
        setPaused(true);
      }
    } catch (e) {
      console.warn('[voice] pause/resume failed:', e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    if (!startedRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    // Capture duration before stop — the recorder state resets afterwards.
    const durationMillis = state.durationMillis ?? 0;
    try {
      await recorder.stop();
    } catch {
      // ignore — we still try to read whatever uri exists
    }
    resetAudioMode();
    const uri = recorder.uri;
    if (uri) onStop(uri, durationMillis);
    else onClose();
  };

  // Backgrounding mid-recording: iOS suspends the JS thread and the native
  // recorder state comes back inconsistent — the take could die silently
  // (H14). Auto-stop and hand the captured audio to transcription instead,
  // so the user returns to their take rather than a broken recorder.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' && startedRef.current && !stoppingRef.current) {
        void stopRef.current();
      }
    });
    return () => sub.remove();
  }, []);

  const discard = () => {
    if (startedRef.current && !stoppingRef.current) {
      stoppingRef.current = true;
      // Discard: stop, delete the temp take, restore the audio session.
      recorder
        .stop()
        .catch(() => {})
        .then(() => {
          const uri = recorder.uri;
          if (uri) return deleteAsync(uri, { idempotent: true }).catch(() => {});
        })
        .finally(resetAudioMode);
    }
    onClose();
  };

  // X sits 30pt from the stop button and silently threw the take away — a
  // misclick after a long take was the flow's worst possible ending. Under
  // 10s a discard costs nothing; past that, confirm. Recording continues
  // while the alert is up, so "Behold" simply resumes the flow.
  const close = () => {
    const secs = Math.floor((state.durationMillis ?? 0) / 1000);
    if (secs < 10 || stoppingRef.current) {
      discard();
      return;
    }
    const mins = Math.floor(secs / 60);
    const lengthLabel =
      mins > 0 ? `${mins} ${mins === 1 ? 'minut' : 'minutters'}` : `${secs} sekunders`;
    Alert.alert('Kassér optagelsen?', `${lengthLabel} tale slettes permanent.`, [
      { text: 'Behold', style: 'cancel' },
      { text: 'Kassér', style: 'destructive', onPress: discard },
    ]);
  };

  // Past an hour "73:12" reads wrong — switch to H:MM:SS (QA L5).
  const totalSecs = Math.floor((state.durationMillis ?? 0) / 1000);
  const hh = Math.floor(totalSecs / 3600);
  const mm = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSecs % 60).padStart(2, '0');
  const timerLabel = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;

  const side = {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 1,
    borderColor: papirColor.line,
    backgroundColor: papirColor.card,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper, alignItems: 'center', paddingTop: insets.top + 24 }}>
      <PaperText role="eyebrow" color={papirColor.ink3}>
        Optager
      </PaperText>
      <PaperText role="price" tabular style={{ marginTop: 80 }}>
        {timerLabel}
      </PaperText>
      <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 8 }}>
        {paused ? 'Pause' : 'Lytter…'}
      </PaperText>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 3,
          height: 90,
          marginTop: 46,
          paddingHorizontal: 30,
        }}
      >
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <WaveBar key={i} levels={levels} index={i} paused={paused} />
        ))}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 30, marginTop: 'auto', marginBottom: 50 }}>
        <ScaleButton scaleTo={0.9} haptic="light" onPress={togglePause} style={side} accessibilityLabel={paused ? 'Fortsæt' : 'Pause'}>
          {paused ? (
            <Play size={20} color={papirColor.ink} strokeWidth={1.8} />
          ) : (
            <Pause size={20} color={papirColor.ink} strokeWidth={1.8} />
          )}
        </ScaleButton>
        <ScaleButton
          scaleTo={0.92}
          haptic="medium"
          onPress={stop}
          accessibilityLabel={`Stop optagelse, ${timerLabel}`}
          style={[
            { width: 78, height: 78, borderRadius: 39, backgroundColor: papirColor.ink, alignItems: 'center', justifyContent: 'center' },
            papirShadow.ink,
          ]}
        >
          <View style={{ width: 26, height: 26, borderRadius: 8, backgroundColor: papirColor.paper }} />
        </ScaleButton>
        <ScaleButton scaleTo={0.9} haptic="light" onPress={close} style={side} accessibilityLabel="Annullér">
          <X size={20} color={papirColor.ink} strokeWidth={1.8} />
        </ScaleButton>
      </View>
    </View>
  );
}
