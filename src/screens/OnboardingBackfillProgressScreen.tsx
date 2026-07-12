// src/screens/OnboardingBackfillProgressScreen.tsx
//
// Loading screen between intro Start tap and the review screen. Polls the
// backfill-status edge function for completion + per-service failures.
//
// Papir-redesign — "Notesbogen": i stedet for en spinner ser brugeren Zolva
// arbejde. Brand-bølgen ånder med løftet amplitude ("jeg lytter"), en
// Fraunces-faseoverskrift skifter roligt ("Jeg læser dine mails." → "Jeg
// kigger i din kalender."), og på ét hvidt ark skriver statuslinjer sig
// selv ind, én ad gangen — drevet af de RIGTIGE backfill-jobs, så fejl og
// fuldførelse altid er sande. En tynd terracotta-linje øverst på arket
// viser reel fremdrift. "Show the work" er kurateret teater i tempoet,
// men aldrig i indholdet: fejlede jobs vises ærligt som dæmpede linjer,
// og skærmen slutter først, når scanningen reelt er færdig (eller
// timeout/ceiling rammer — samme kontrakt som før).
//
// Reduce Motion: alle linjer står fremme med det samme, bølgen står
// stille, ingen pulserende prikker. Completion-timing er uændret.

import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import {
  BreathingWave,
  PaperText,
  papirColor,
  papirEasing,
  papirRadius,
  papirShadow,
  papirSpace,
} from '../design/papir';
import { cancelBackfill, fetchBackfillStatus, type BackfillJob } from '../lib/onboarding-backfill';
import { isBackfillComplete, failedJobs } from '../lib/backfill-progress';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_ATTEMPTS = 80; // ~2 minutes

// Minimum total animation time from mount. Fast scans (~200-800ms) used
// to snap-cut and feel un-rewarding; the floor pads them so "Zolva is
// doing work" reads long enough for the narrative to land. Slow scans
// transition as soon as the scan completes.
const ANIMATION_FLOOR_MS = 3000;

// Force-exit if the scan never reaches a terminal state. Tighter than the
// 120s poll budget - caps how long the user watches before we get out of
// the way. Error UI is a separate ticket.
const ANIMATION_CEILING_MS = 45_000;

// Ro i afsløringen: en ny linje ca. hvert 1,6. sekund mens der arbejdes;
// når scanningen er færdig, spoler resten hurtigt (men blidt) frem.
const REVEAL_MS = 1600;
const REVEAL_FAST_MS = 260;
const MAX_VISIBLE_LINES = 6;

type ServiceKind = 'mail' | 'calendar' | 'drive';
type LineKind = ServiceKind | 'tail';

type NarrativeLine = {
  key: string;
  kind: LineKind;
  /** Matches `${provider}:${kind}` for real jobs; null for teater-linjer. */
  jobKey: string | null;
  activeText: string;
  doneText: string;
  failedText?: string;
};

const PROVIDER_NAME: Record<string, string> = {
  google: 'Google',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

const SERVICE_NAME: Record<string, string> = {
  'google:mail': 'Gmail',
  'microsoft:mail': 'Outlook Mail',
  'icloud:mail': 'iCloud Mail',
  'google:calendar': 'Google Kalender',
  'microsoft:calendar': 'Outlook Kalender',
  'google:drive': 'Google Drive',
  'microsoft:drive': 'OneDrive',
};

// Stable narrative order regardless of how jobs come back from the API.
const JOB_ORDER = [
  'google:mail',
  'microsoft:mail',
  'icloud:mail',
  'google:calendar',
  'microsoft:calendar',
  'google:drive',
  'microsoft:drive',
];

function lineForJob(key: string): NarrativeLine | null {
  const name = SERVICE_NAME[key];
  if (!name) return null;
  const kind = key.split(':')[1] as ServiceKind;
  if (kind === 'mail') {
    return {
      key,
      kind,
      jobKey: key,
      activeText: `Organiserer dine mails i ${name}…`,
      doneText: `${name} læst og organiseret`,
      failedText: `Kunne ikke læse ${name}`,
    };
  }
  if (kind === 'calendar') {
    return {
      key,
      kind,
      jobKey: key,
      activeText: `Finder dine kommende møder i ${name}…`,
      doneText: `${name} gennemgået`,
      failedText: `Kunne ikke læse ${name}`,
    };
  }
  return {
    key,
    kind,
    jobKey: key,
    activeText: `Ser på dine dokumenter i ${name}…`,
    doneText: `${name} gennemgået`,
    failedText: `Kunne ikke læse ${name}`,
  };
}

// Teater-halen: altid til stede, fuldføres når scanningen reelt er færdig.
const TAIL_LINES: NarrativeLine[] = [
  {
    key: 'tail:preferences',
    kind: 'tail',
    jobKey: null,
    activeText: 'Lærer dine præferencer…',
    doneText: 'Præferencer noteret',
  },
  {
    key: 'tail:briefing',
    kind: 'tail',
    jobKey: null,
    activeText: 'Klargør din første briefing…',
    doneText: 'Din første briefing er klar',
  },
];

const PHASE_HEADLINE: Record<LineKind | 'connect', string> = {
  connect: 'Jeg forbinder dine konti.',
  mail: 'Jeg læser dine mails.',
  calendar: 'Jeg kigger i din kalender.',
  drive: 'Jeg ser på dine dokumenter.',
  tail: 'Jeg samler det vigtigste.',
};

function jobStatusFor(jobs: BackfillJob[], jobKey: string): 'active' | 'done' | 'failed' {
  const [provider, kind] = jobKey.split(':');
  const job = jobs.find((j) => j.provider === provider && j.kind === kind);
  if (!job) return 'active';
  if (job.status === 'failed' || job.status === 'cancelled') return 'failed';
  if (job.status === 'done') return 'done';
  return 'active';
}

type Props = {
  onComplete: (failed: BackfillJob[]) => void;
};

export function OnboardingBackfillProgressScreen({ onComplete }: Props) {
  const reduceMotion = useReducedMotion();
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  // Flips true once the first status poll resolves (even with zero jobs), so
  // the completion effect can tell "no jobs to track" apart from "haven't
  // polled yet" and finish promptly instead of waiting the animation ceiling.
  const [firstPollDone, setFirstPollDone] = useState(false);
  const [revealed, setRevealed] = useState(1);
  const [settled, setSettled] = useState(false);
  const completedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const jobsRef = useRef<BackfillJob[]>([]);
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // Unmount-only cleanup for the completion timer. The timer itself is
  // scheduled inside the completion effect below but MUST survive re-runs
  // of that effect - otherwise every poll-driven jobs change cancels the
  // pending onComplete and the screen hangs forever.
  useEffect(() => {
    return () => {
      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      // If the screen is torn down before the backfill finished (the user
      // left onboarding), cancel the server-side workers so they stop
      // spending Claude tokens on work no one will see. On normal completion
      // completedRef is already true, so this never cancels real results.
      if (!completedRef.current) {
        void cancelBackfill().catch(() => {});
      }
    };
  }, []);

  // Poll the backfill status. Same endpoint as the old screen.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const fresh = await fetchBackfillStatus();
        if (cancelled) return;
        setJobs(fresh);
        setFirstPollDone(true);
      } catch {
        // Silent - keep polling. The completion handler has its own
        // timeout fallback if the endpoint stays unreachable.
      }
      if (attempts >= POLL_TIMEOUT_ATTEMPTS && !cancelled && !completedRef.current) {
        completedRef.current = true;
        // Use the live ref, not the stale `jobs` captured by this []-deps
        // effect closure, so timed-out runs actually report their failures.
        // Only genuine failures — jobs still running at the timeout keep
        // processing server-side and must not be shown as failed.
        onComplete(failedJobs(jobsRef.current));
      }
    };
    void poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // onComplete intentionally not in deps - we want a stable poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animation ceiling - force-exit if scan never reaches terminal state.
  useEffect(() => {
    const id = setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      // Only genuine failures — a long backfill that hasn't finished by the
      // animation ceiling keeps running server-side; don't mislabel it failed.
      onComplete(failedJobs(jobsRef.current));
    }, ANIMATION_CEILING_MS);
    return () => clearTimeout(id);
    // onComplete intentionally not in deps - stable single-fire timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fortællingen: én linje pr. reelt job (stabil rækkefølge) + teater-halen.
  // Før første poll kender vi ikke jobbene - så viser vi kun første linje af
  // halen som "forbinder"-fase via headline.
  const lines = useMemo<NarrativeLine[]>(() => {
    const present = new Set(
      jobs
        .filter((j) => j.kind === 'mail' || j.kind === 'calendar' || j.kind === 'drive')
        // iCloud only has a mail-backfill job; calendar lives in daily-brief.
        .filter((j) => !(j.provider === 'icloud' && j.kind !== 'mail'))
        .map((j) => `${j.provider}:${j.kind}`),
    );
    const jobLines = JOB_ORDER.filter((k) => present.has(k))
      .map(lineForJob)
      .filter((l): l is NarrativeLine => l !== null);
    return [...jobLines, ...TAIL_LINES];
  }, [jobs]);

  const scanComplete = isBackfillComplete(jobs, firstPollDone);

  // Afsløringstakt: rolig mens der arbejdes, hurtig fremspoling når
  // scanningen er færdig. Reduce Motion viser alt med det samme.
  useEffect(() => {
    if (reduceMotion) {
      setRevealed(lines.length);
      return;
    }
    if (revealed >= lines.length) return;
    const id = setTimeout(
      () => setRevealed((r) => Math.min(r + 1, lines.length)),
      scanComplete ? REVEAL_FAST_MS : REVEAL_MS,
    );
    return () => clearTimeout(id);
  }, [revealed, lines.length, scanComplete, reduceMotion]);

  // Completion: every real job is in a terminal state, OR a status poll has
  // confirmed there are no jobs to track at all (e.g. no providers connected),
  // which would otherwise hang on the animation ceiling. Holder til både
  // animations-gulvet OG til fortællingen har spolet færdig, så de sidste
  // linjer når at lande før skiftet ("Din første briefing er klar").
  useEffect(() => {
    if (completedRef.current) return;
    if (!scanComplete) return;
    completedRef.current = true;
    setSettled(true);

    const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled');
    const elapsed = Date.now() - mountedAtRef.current;
    const floorHold = Math.max(0, ANIMATION_FLOOR_MS - elapsed);
    const remaining = Math.max(0, lines.length - revealed);
    const narrativeHold = reduceMotion ? 400 : remaining * REVEAL_FAST_MS + 700;
    // Store in ref so the timer survives re-runs of this effect on jobs
    // changes. Unmount cleanup is handled separately above.
    completionTimerRef.current = setTimeout(
      () => onComplete(failed),
      Math.max(floorHold, narrativeHold),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanComplete, jobs]);

  // Reel fremdrift: andel af jobs i terminal tilstand, blødt blandet med
  // fortællingens fremdrift så linjen aldrig står helt stille (perceived
  // performance) - men den rammer først 100 %, når scanningen ER færdig.
  const progress = useSharedValue(0.06);
  const jobKeys = useMemo(
    () => lines.filter((l) => l.jobKey).map((l) => l.jobKey as string),
    [lines],
  );
  const doneFraction =
    jobKeys.length === 0
      ? 0
      : jobKeys.filter((k) => jobStatusFor(jobs, k) !== 'active').length / jobKeys.length;
  const revealFraction = lines.length === 0 ? 0 : revealed / lines.length;
  useEffect(() => {
    const target = scanComplete
      ? 1
      : Math.min(0.92, 0.06 + doneFraction * 0.7 + revealFraction * 0.18);
    progress.value = withTiming(target, { duration: 900, easing: papirEasing });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneFraction, revealFraction, scanComplete]);

  const progressStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: progress.value }],
  }));

  // Faseoverskriften følger den nyeste aktive linje.
  const phase = useMemo<LineKind | 'connect'>(() => {
    if (!firstPollDone && jobs.length === 0) return 'connect';
    for (let i = Math.min(revealed, lines.length) - 1; i >= 0; i -= 1) {
      const l = lines[i];
      const status = l.jobKey ? jobStatusFor(jobs, l.jobKey) : settled ? 'done' : 'active';
      if (status === 'active') return l.kind;
    }
    return lines.length > 0 ? lines[Math.min(revealed, lines.length) - 1].kind : 'connect';
  }, [firstPollDone, jobs, lines, revealed, settled]);

  const visibleLines = lines.slice(0, revealed).slice(-MAX_VISIBLE_LINES);

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: papirSpace.screen,
          paddingTop: 76,
          paddingBottom: 48,
        }}
      >
        {/* Eyebrow + faseoverskrift (fast højde så krydsfadet aldrig hopper). */}
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Lærer dig at kende
        </PaperText>
        <View style={{ height: 76, justifyContent: 'flex-end' }}>
          <Animated.View
            key={settled ? 'settled' : phase}
            entering={FadeInDown.duration(480).easing(Easing.out(Easing.quad))}
            exiting={FadeOut.duration(240)}
          >
            <PaperText role="displayS" accessibilityRole="header">
              {settled ? 'Så er jeg med.' : PHASE_HEADLINE[phase]}
            </PaperText>
          </Animated.View>
        </View>

        {/* Bølgen arbejder - amplituden falder til ro, når scanningen er færdig. */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Animated.View entering={FadeIn.duration(700)}>
            <BreathingWave listening={!settled} scale={1.15} />
          </Animated.View>
        </View>

        {/* Arket: fremdriftslinje + selvskrivende notat-linjer. */}
        <Animated.View
          entering={FadeInDown.delay(150).duration(560).easing(Easing.out(Easing.cubic))}
          style={{
            backgroundColor: papirColor.card,
            borderRadius: papirRadius.card,
            overflow: 'hidden',
            ...papirShadow.base,
          }}
        >
          <View style={{ height: 3, backgroundColor: papirColor.lineSoft }}>
            <Animated.View
              style={[
                {
                  height: 3,
                  backgroundColor: papirColor.red,
                  transformOrigin: 'left',
                },
                progressStyle,
              ]}
            />
          </View>
          <View style={{ paddingVertical: papirSpace.md, paddingHorizontal: papirSpace.lg }}>
            {visibleLines.map((l) => {
              const status = l.jobKey
                ? jobStatusFor(jobs, l.jobKey)
                : settled
                  ? 'done'
                  : 'active';
              return (
                <NarrativeRow
                  key={l.key}
                  line={l}
                  status={status}
                  reduceMotion={reduceMotion}
                />
              );
            })}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

// ─── Notat-linje ─────────────────────────────────────────────────────────────
// Aktiv: pulserende terracotta-prik + arbejdstekst. Færdig: grøn prik, dæmpet
// tekst der falder til ro. Fejlet: rust-prik + ærlig besked (review-skærmens
// banner tilbyder "Prøv igen").

function NarrativeRow({
  line,
  status,
  reduceMotion,
}: {
  line: NarrativeLine;
  status: 'active' | 'done' | 'failed';
  reduceMotion: boolean;
}) {
  const text =
    status === 'failed'
      ? line.failedText ?? line.doneText
      : status === 'done'
        ? line.doneText
        : line.activeText;
  const dotColor =
    status === 'failed'
      ? papirColor.rust
      : status === 'done'
        ? papirColor.green
        : papirColor.red;

  return (
    <Animated.View
      entering={FadeInDown.duration(440).easing(Easing.out(Easing.quad))}
      layout={LinearTransition.duration(320)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: papirSpace.md,
        paddingVertical: papirSpace.sm + 2,
      }}
    >
      {status === 'active' && !reduceMotion ? (
        <PulsingDot color={dotColor} />
      ) : (
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor }}
        />
      )}
      <PaperText
        role={status === 'active' ? 'bodyStrong' : 'body'}
        color={status === 'active' ? papirColor.ink : papirColor.ink3}
        style={{ flex: 1 }}
      >
        {text}
      </PaperText>
    </Animated.View>
  );
}

function PulsingDot({ color }: { color: string }) {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(0.3, { duration: 700, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }, style]}
    />
  );
}
