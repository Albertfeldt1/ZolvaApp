// src/screens/OnboardingChatQuestionsScreen.tsx
//
// Shown WHILE the backfill worker is running. Asks 3 short Danish
// questions; each submission fires runExtractor({trigger:'chat_turn'})
// so facts pile up in real time alongside the mail/calendar backfill
// output. Bottom polls fetchBackfillStatus every 3s (up to ~2 min) and
// gates the "Fortsæt" button on isAllDone(jobs).
//
// Visual style mirrors OnboardingBackfillScreen for onboarding flow
// consistency. Wiring into App.tsx is Task 13.

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useChromeInsets } from '../components/PhoneChrome';
import { subscribeUserId } from '../lib/auth';
import {
  fetchBackfillStatus,
  isAllDone,
  progressLabel,
  type BackfillJob,
} from '../lib/onboarding-backfill';
import { runExtractor } from '../lib/profile-extractor';
import { colors, fonts } from '../theme';

type QuestionId = 'Q1' | 'Q2' | 'Q3';

type Question = {
  id: QuestionId;
  label: string;
  placeholder: string;
};

const QUESTIONS: readonly Question[] = [
  {
    id: 'Q1',
    label: 'Hvad arbejder du med?',
    placeholder: 'Marketing, salg, udvikling, …',
  },
  {
    id: 'Q2',
    label: 'Hvem er dine 2-3 vigtigste kolleger eller kunder?',
    placeholder: 'Maria fra salg, Lars fra Acme A/S, …',
  },
  {
    id: 'Q3',
    label: 'Hvilke deadlines eller projekter har du i øjeblikket?',
    placeholder: 'Q2-budget i april, lancering i juni, …',
  },
];

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~2 minutes

type Props = {
  onContinue: () => void;
};

export function OnboardingChatQuestionsScreen({ onContinue }: Props) {
  const { bottom: chromeBottom } = useChromeInsets();

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => subscribeUserId(setUserId), []);

  const [answers, setAnswers] = useState<Record<QuestionId, string>>({
    Q1: '',
    Q2: '',
    Q3: '',
  });
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll backfill status every 3s until isAllDone(jobs) or ~2min timeout.
  // Failures are silent — the screen has a 'Fortsæt' fallback that enables
  // when jobs[] is empty (isAllDone([]) === true).
  useEffect(() => {
    let attempts = 0;
    let cancelled = false;

    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const poll = async () => {
      attempts += 1;
      try {
        const fresh = await fetchBackfillStatus();
        if (cancelled) return;
        setJobs(fresh);
        if (isAllDone(fresh) || attempts >= MAX_POLL_ATTEMPTS) {
          stopPolling();
        }
      } catch {
        if (attempts >= MAX_POLL_ATTEMPTS) stopPolling();
      }
    };

    void poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, []);

  const submit = (id: QuestionId) => {
    if (!userId) return;
    const text = answers[id].trim();
    if (!text) return;
    const q = QUESTIONS.find((x) => x.id === id);
    if (!q) return;
    runExtractor({
      trigger: 'chat_turn',
      userId,
      text: `${q.label}\nBruger: ${text}`,
      source: `onboarding:${id}`,
    });
    // Clear the input — empty field is the "I sent that" feedback.
    setAnswers((cur) => ({ ...cur, [id]: '' }));
  };

  const skip = (id: QuestionId) => {
    // Just clear the input; do NOT fire runExtractor.
    setAnswers((cur) => ({ ...cur, [id]: '' }));
  };

  const allDone = isAllDone(jobs);

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 32 }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
        overScrollMode="never"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>LÆR DIG AT KENDE</Text>
          <Text style={styles.heroH1}>Mens jeg læser…</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.body}>
            Mens jeg læser dine emails og kalender, må jeg gerne stille dig 3 hurtige spørgsmål? Du kan springe alle over.
          </Text>

          {QUESTIONS.map((q) => {
            const value = answers[q.id];
            const trimmed = value.trim();
            const canSend = trimmed.length > 0;
            return (
              <View key={q.id} style={styles.card}>
                <Text style={styles.label}>{q.label}</Text>
                <TextInput
                  style={styles.input}
                  value={value}
                  onChangeText={(t) => setAnswers((cur) => ({ ...cur, [q.id]: t }))}
                  placeholder={q.placeholder}
                  placeholderTextColor={colors.fg3}
                  multiline
                  blurOnSubmit
                  returnKeyType="done"
                  onSubmitEditing={() => submit(q.id)}
                />
                <View style={styles.cardRow}>
                  <Pressable
                    onPress={() => submit(q.id)}
                    disabled={!canSend}
                    style={[styles.cardBtn, !canSend && styles.cardBtnDisabled]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.cardBtnText}>Send</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => skip(q.id)}
                    style={styles.cardSkip}
                    accessibilityRole="button"
                  >
                    <Text style={styles.cardSkipText}>Spring over</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}

          <View style={styles.progress}>
            {!allDone && <ActivityIndicator color={colors.sageDeep} />}
            <Text style={styles.progressText}>{progressLabel(jobs)}</Text>
          </View>

          <Pressable
            onPress={onContinue}
            disabled={!allDone}
            style={[styles.primaryBtn, !allDone && styles.primaryBtnDisabled]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryBtnText}>
              {allDone ? 'Fortsæt' : 'Vent et øjeblik…'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },
  scroll: { flexGrow: 1, backgroundColor: colors.paper },
  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12,
    fontFamily: fonts.displayItalic,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -1,
    color: colors.ink,
  },
  section: { paddingHorizontal: 20, paddingTop: 24 },
  body: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  card: {
    marginTop: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.mist,
    gap: 10,
  },
  label: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
  },
  input: {
    fontFamily: fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
    backgroundColor: colors.paper,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 64,
    textAlignVertical: 'top',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  cardBtn: {
    backgroundColor: colors.ink,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cardBtnDisabled: { opacity: 0.4 },
  cardBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.paper,
  },
  cardSkip: {
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  cardSkipText: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.fg3,
  },
  progress: {
    marginTop: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  progressText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg2,
  },
  primaryBtn: {
    marginTop: 16,
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 15,
    color: colors.paper,
  },
});
