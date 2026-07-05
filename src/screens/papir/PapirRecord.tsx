import React, { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
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
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirDuration, papirShadow } from '../../design/papir';

type Props = {
  /** Called with the recorded file URI + duration when the user stops. */
  onStop: (uri: string, durationMillis: number) => void;
  onClose: () => void;
};

const BAR_COUNT = 34;

/** Leave the iOS audio session in playback mode — recording mode mutes other
 * apps' audio and must never outlive this screen. Best-effort. */
function resetAudioMode(): void {
  setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
}

/** Full-screen record overlay: real expo-audio recording + live UI. */
export function PapirRecord({ onStop, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);
  const [paused, setPaused] = useState(false);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(8));
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
          Alert.alert('Mikrofon-adgang', 'Giv Zolva adgang til mikrofonen for at optage stemme-noter.');
          onClose();
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

  // Decorative live waveform while recording (the real meter API is flaky
  // across devices; the recording itself is real, this is just the visual).
  useEffect(() => {
    if (paused) return;
    const w = setInterval(() => {
      setBars(Array.from({ length: BAR_COUNT }, () => 6 + Math.round(Math.random() * 78)));
    }, papirDuration.waveTick);
    return () => clearInterval(w);
  }, [paused]);

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

  const close = () => {
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

  const totalSecs = Math.floor((state.durationMillis ?? 0) / 1000);
  const mm = String(Math.floor(totalSecs / 60)).padStart(2, '0');
  const ss = String(totalSecs % 60).padStart(2, '0');

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
        {mm}:{ss}
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
        {bars.map((h, i) => (
          <View key={i} style={{ width: 3.5, height: paused ? 6 : h, borderRadius: 4, backgroundColor: papirColor.red }} />
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
          accessibilityLabel="Stop optagelse"
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
