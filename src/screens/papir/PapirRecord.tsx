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
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirDuration, papirShadow } from '../../design/papir';

type Props = {
  /** Called with the recorded file URI when the user stops. */
  onStop: (uri: string) => void;
  onClose: () => void;
};

const BAR_COUNT = 34;

/** Full-screen record overlay: real expo-audio recording + live UI. */
export function PapirRecord({ onStop, onClose }: Props) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder);
  const [paused, setPaused] = useState(false);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(8));
  const startedRef = useRef(false);

  // Request mic permission + start recording once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Mikrofon-adgang', 'Giv Zolva adgang til mikrofonen for at optage stemme-noter.');
        onClose();
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      if (cancelled) return;
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedRef.current = true;
    })();
    return () => {
      cancelled = true;
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
    if (paused) {
      recorder.record();
      setPaused(false);
    } else {
      recorder.pause();
      setPaused(true);
    }
  };

  const stop = async () => {
    try {
      await recorder.stop();
    } catch {
      // ignore — we still try to read whatever uri exists
    }
    const uri = recorder.uri;
    if (uri) onStop(uri);
    else onClose();
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
    <View style={{ flex: 1, backgroundColor: papirColor.paper, alignItems: 'center', paddingTop: 70 }}>
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
        <ScaleButton scaleTo={0.9} haptic="light" onPress={onClose} style={side} accessibilityLabel="Annullér">
          <X size={20} color={papirColor.ink} strokeWidth={1.8} />
        </ScaleButton>
      </View>
    </View>
  );
}
