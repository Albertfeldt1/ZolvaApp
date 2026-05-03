// src/screens/OnboardingBackfillProgressScreen.tsx
//
// Loading screen between intro Start tap and the review screen. Polls the
// backfill-status edge function for completion + per-service failures, but
// the orbit visuals are intentionally decoupled from job count: a fixed
// pool of ambient slots cycles through the logo set — each slot picks a
// random logo, fades in from off-screen, orbits the Stone briefly, gets
// sucked into the Stone, and respawns with a new logo and angle. Real
// failed jobs render as a separate static layer at the periphery with a
// warning badge so the user still sees actual problems.
//
// Reduce Motion: ambient slots collapse to a single static cluster fade
// (no orbit, no absorption), Stone stops breathing/scanning. Completion
// timing is unaffected.
//
// Stone has an idle breathing animation throughout, a slow horizontal
// scan to suggest "looking around" (the SVG-eye gaze inside Stone is too
// subtle at this size), and pulses on completion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Image, ImageSourcePropType, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Stone } from '../components/Stone';
import { fetchBackfillStatus, type BackfillJob } from '../lib/onboarding-backfill';
import { colors, fonts } from '../theme';

type ServiceId = 'google:mail' | 'google:calendar' | 'microsoft:mail' | 'microsoft:calendar';

const SERVICE_META: Record<ServiceId, { logo: ImageSourcePropType; label: string }> = {
  'google:mail': { logo: require('../../assets/logos/gmail.png'), label: 'Gmail' },
  'google:calendar': { logo: require('../../assets/logos/google-calendar.png'), label: 'Google Kalender' },
  'microsoft:mail': { logo: require('../../assets/logos/outlook-mail.png'), label: 'Outlook' },
  'microsoft:calendar': { logo: require('../../assets/logos/outlook-calendar.png'), label: 'Outlook Kalender' },
};

// Ambient orbit pool — purely visual. Wider than the actual backfill set
// so the screen feels lively even for users with only one or two real
// jobs. iCloud + Drive logos appear here as flavour even though they're
// not currently part of the backfill flow.
const AMBIENT_LOGOS: ImageSourcePropType[] = [
  require('../../assets/logos/gmail.png'),
  require('../../assets/logos/google-calendar.png'),
  require('../../assets/logos/outlook-mail.png'),
  require('../../assets/logos/outlook-calendar.png'),
  require('../../assets/logos/icloud.png'),
  require('../../assets/logos/google-drive.png'),
];

const AMBIENT_SLOT_COUNT = 5;

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_ATTEMPTS = 80; // ~2 minutes

const RADIUS_OFFSCREEN = 220;
const RADIUS_ORBIT = 92;
const RADIUS_FAILED = 138;

const STONE_BREATHE_MS = 3200;
const STONE_SCAN_MS = 4200;
const STONE_PULSE_UP_MS = 380;
const STONE_PULSE_DOWN_MS = 620;

// Minimum total animation time from mount. Fast scans (~200-800ms) used
// to snap-cut and feel un-rewarding; the floor pads them so "Zolva is
// doing work" reads long enough for the user to see the orbit + Stone
// pulse before transition. Slow scans transition as soon as the scan
// completes (slot pool keeps looping in the meantime).
const ANIMATION_FLOOR_MS = 3000;

// Force-exit if the scan never reaches a terminal state. Tighter than the
// 120s poll budget — caps how long the user stares at orbiting logos
// before we get out of the way. Error UI is a separate ticket.
const ANIMATION_CEILING_MS = 45_000;

const STONE_SIZE = 132;
const ICON_SIZE = 44;

function jobKey(j: BackfillJob): ServiceId | null {
  if (j.provider === 'icloud') return null;
  if (j.kind !== 'mail' && j.kind !== 'calendar') return null;
  return `${j.provider}:${j.kind}` as ServiceId;
}

function failedServiceIds(jobs: BackfillJob[]): ServiceId[] {
  const out: ServiceId[] = [];
  const seen = new Set<ServiceId>();
  for (const j of jobs) {
    if (j.status !== 'failed' && j.status !== 'cancelled') continue;
    const k = jobKey(j);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

type Props = {
  onComplete: (failed: BackfillJob[]) => void;
};

export function OnboardingBackfillProgressScreen({ onComplete }: Props) {
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const [reduceMotion, setReduceMotion] = useState(false);
  const completedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const jobsRef = useRef<BackfillJob[]>([]);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  const stoneScale = useSharedValue(1);
  const stoneRotate = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (!cancelled) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { cancelled = true; sub.remove(); };
  }, []);

  // Idle breathing + scan on the Stone — runs from mount until completion.
  useEffect(() => {
    if (reduceMotion) return;
    stoneScale.value = withRepeat(
      withSequence(
        withTiming(1.045, { duration: STONE_BREATHE_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: STONE_BREATHE_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    // Slow head-tilt scan: ±6° over ~4s. The SVG-eye gaze inside Stone is
    // too subtle at this size to read as "looking around"; this rotation
    // on the wrap reads clearly without affecting the orbiting icons,
    // which are siblings of the stoneWrap.
    stoneRotate.value = withRepeat(
      withSequence(
        withTiming(6, { duration: STONE_SCAN_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(-6, { duration: STONE_SCAN_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    return () => {
      cancelAnimation(stoneScale);
      cancelAnimation(stoneRotate);
    };
  }, [reduceMotion, stoneScale, stoneRotate]);

  // Poll the backfill status. Same endpoint the previous questions screen used.
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const fresh = await fetchBackfillStatus();
        if (cancelled) return;
        setJobs(fresh);
      } catch {
        // Silent — keep polling. The completion handler has its own
        // timeout fallback if the endpoint stays unreachable.
      }
      if (attempts >= POLL_TIMEOUT_ATTEMPTS && !cancelled && !completedRef.current) {
        completedRef.current = true;
        onComplete(jobs.filter((j) => j.status !== 'done'));
      }
    };
    void poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // onComplete intentionally not in deps — we want a stable poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Animation ceiling — force-exit if scan never reaches terminal state.
  // Tighter than the 120s poll-attempt budget; this is the *animation*
  // hard cap, not the poll cap. Error UI is a separate ticket.
  useEffect(() => {
    const id = setTimeout(() => {
      if (completedRef.current) return;
      completedRef.current = true;
      onComplete(jobsRef.current.filter((j) => j.status !== 'done'));
    }, ANIMATION_CEILING_MS);
    return () => clearTimeout(id);
    // onComplete intentionally not in deps — stable single-fire timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Completion: every real job is in a terminal state.
  useEffect(() => {
    if (completedRef.current) return;
    if (jobs.length === 0) return;
    const allTerminal = jobs.every(
      (j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled',
    );
    if (!allTerminal) return;
    completedRef.current = true;

    if (!reduceMotion) {
      stoneScale.value = withSequence(
        withTiming(1.18, { duration: STONE_PULSE_UP_MS, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: STONE_PULSE_DOWN_MS, easing: Easing.in(Easing.cubic) }),
      );
    }

    const failed = jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled');
    // 3s floor from mount — fast scans pad to feel rewarding, slow scans
    // transition immediately when the scan finishes.
    const elapsed = Date.now() - mountedAtRef.current;
    const hold = Math.max(0, ANIMATION_FLOOR_MS - elapsed);
    const id = setTimeout(() => onComplete(failed), hold);
    return () => clearTimeout(id);
  }, [jobs, reduceMotion, stoneScale, onComplete]);

  const stoneStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: stoneScale.value },
      { rotate: `${stoneRotate.value}deg` },
    ],
  }));

  const failedIds = useMemo(() => failedServiceIds(jobs), [jobs]);

  // Stable seed list for ambient slots so they don't remount every render.
  const ambientSlots = useMemo(
    () => Array.from({ length: AMBIENT_SLOT_COUNT }, (_, i) => i),
    [],
  );

  return (
    <View style={styles.flex}>
      <View style={styles.center}>
        <Animated.View style={[styles.stoneWrap, stoneStyle]} pointerEvents="none">
          <Stone mood="thinking" size={STONE_SIZE} />
        </Animated.View>

        {ambientSlots.map((slot) => (
          <AmbientIcon key={slot} slot={slot} reduceMotion={reduceMotion} />
        ))}

        {failedIds.map((id, i) => (
          <FailedIcon
            key={id}
            id={id}
            angleDeg={(i * 360) / Math.max(1, failedIds.length) - 90}
          />
        ))}
      </View>
      <View style={styles.captionWrap} pointerEvents="none">
        <Text style={styles.eyebrow}>LÆR DIG AT KENDE</Text>
        <Text style={styles.caption}>Læser dine emails og kalender…</Text>
      </View>
    </View>
  );
}

// ─── Ambient orbiter ───────────────────────────────────────────────────
//
// Each slot runs its own self-sustaining loop: pick a random logo, fade
// in from the offscreen radius, orbit briefly, get sucked into the Stone,
// then schedule the next cycle with a fresh logo and angle. Slots are
// independent so their cycles desync over time and the screen never
// looks like a step function.

type AmbientIconProps = {
  slot: number;
  reduceMotion: boolean;
};

function AmbientIcon({ slot, reduceMotion }: AmbientIconProps) {
  const radius = useSharedValue(RADIUS_OFFSCREEN);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);
  const angle = useSharedValue(0);

  // Logo + start-angle picked per cycle. We re-pick on each absorb so the
  // user sees variety, but useState lets us trigger a re-render cleanly
  // (the alternative — picking inside an Animated callback — gets messy).
  const [logoIdx, setLogoIdx] = useState(() =>
    Math.floor(Math.random() * AMBIENT_LOGOS.length),
  );

  // Refs let the timeout chain see the latest setters without re-binding.
  const cycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cycleTimer.current) clearTimeout(cycleTimer.current);
      cancelAnimation(radius);
      cancelAnimation(opacity);
      cancelAnimation(scale);
      cancelAnimation(angle);
    };
  }, [radius, opacity, scale, angle]);

  const startCycle = useCallback(() => {
    if (!mountedRef.current) return;

    // Fresh logo + angle per cycle.
    const nextLogoIdx = Math.floor(Math.random() * AMBIENT_LOGOS.length);
    const startAngle = Math.random() * 360;
    setLogoIdx(nextLogoIdx);
    angle.value = startAngle;
    radius.value = RADIUS_OFFSCREEN;
    scale.value = 1;
    opacity.value = 0;

    if (reduceMotion) {
      // Static cluster: settle at orbit radius, fade in, never absorb.
      radius.value = RADIUS_ORBIT;
      opacity.value = withTiming(0.85, { duration: 400 });
      return;
    }

    const driftMs = 700 + Math.random() * 600;     // 0.7–1.3s drift in
    const orbitMs = 2200 + Math.random() * 2400;   // 2.2–4.6s orbiting
    const absorbMs = 480 + Math.random() * 220;    // 0.48–0.7s absorb
    // Light orbital drift while it's visible — we sweep the angle by a
    // moderate amount rather than completing a full revolution so each
    // cycle has a clear arc.
    const orbitSweepDeg = (Math.random() * 220 + 80) * (Math.random() < 0.5 ? -1 : 1);

    opacity.value = withTiming(1, { duration: driftMs, easing: Easing.out(Easing.cubic) });
    radius.value = withTiming(RADIUS_ORBIT, { duration: driftMs, easing: Easing.out(Easing.cubic) });
    angle.value = withTiming(startAngle + orbitSweepDeg, {
      duration: driftMs + orbitMs,
      easing: Easing.linear,
    });

    // Schedule absorb after drift+orbit completes.
    cycleTimer.current = setTimeout(() => {
      if (!mountedRef.current) return;
      radius.value = withTiming(0, { duration: absorbMs, easing: Easing.in(Easing.cubic) });
      scale.value = withTiming(0.18, { duration: absorbMs, easing: Easing.in(Easing.cubic) });
      opacity.value = withTiming(0, { duration: absorbMs }, (finished) => {
        if (finished) runOnJS(scheduleNext)();
      });
    }, driftMs + orbitMs);
  }, [angle, radius, scale, opacity, reduceMotion]);

  const scheduleNext = useCallback(() => {
    if (!mountedRef.current) return;
    // Random re-spawn delay so slots desync over time.
    const gap = 250 + Math.random() * 1100;
    cycleTimer.current = setTimeout(startCycle, gap);
  }, [startCycle]);

  // Initial stagger: slot 0 starts almost immediately, later slots fan
  // out so all five don't drift in at the same instant.
  useEffect(() => {
    const initialDelay = slot * 320 + Math.random() * 480;
    cycleTimer.current = setTimeout(startCycle, initialDelay);
    return () => {
      if (cycleTimer.current) clearTimeout(cycleTimer.current);
    };
    // startCycle is stable after first render via useCallback, but its
    // identity changes if reduceMotion flips — which is fine, the cleanup
    // above kills the in-flight timer and the new effect schedules fresh.
  }, [slot, startCycle]);

  const animatedStyle = useAnimatedStyle(() => {
    const a = (angle.value * Math.PI) / 180;
    const x = Math.cos(a) * radius.value;
    const y = Math.sin(a) * radius.value;
    return {
      transform: [{ translateX: x }, { translateY: y }, { scale: scale.value }],
      opacity: opacity.value,
    };
  });

  return (
    <Animated.View style={[styles.iconAbs, animatedStyle]} pointerEvents="none">
      <View style={styles.iconCard}>
        <Image source={AMBIENT_LOGOS[logoIdx]} style={styles.iconImage} resizeMode="contain" />
      </View>
    </Animated.View>
  );
}

// ─── Failed-job indicator ──────────────────────────────────────────────
//
// Static peripheral icon shown when a real backfill job is in 'failed' or
// 'cancelled' state. Decoupled from the ambient pool so a real failure is
// always visible regardless of which logos the orbit happens to be cycling.

type FailedIconProps = {
  id: ServiceId;
  angleDeg: number;
};

function FailedIcon({ id, angleDeg }: FailedIconProps) {
  const meta = SERVICE_META[id];
  const a = (angleDeg * Math.PI) / 180;
  const x = Math.cos(a) * RADIUS_FAILED;
  const y = Math.sin(a) * RADIUS_FAILED;
  return (
    <View
      style={[
        styles.iconAbs,
        { transform: [{ translateX: x }, { translateY: y }], opacity: 0.42 },
      ]}
      pointerEvents="none"
    >
      <View style={styles.iconCard}>
        <Image source={meta.logo} style={styles.iconImage} resizeMode="contain" />
      </View>
      <View style={styles.warningBadge}>
        <Text style={styles.warningText}>!</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.paper },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stoneWrap: {
    width: STONE_SIZE,
    height: STONE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconAbs: {
    position: 'absolute',
    // Anchor center-of-icon at center-of-parent so transform translateX/Y
    // orbits the Stone (which is the parent's natural-flow centered child).
    top: '50%',
    left: '50%',
    marginTop: -ICON_SIZE / 2,
    marginLeft: -ICON_SIZE / 2,
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCard: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    borderRadius: 12,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  iconImage: {
    width: ICON_SIZE - 12,
    height: ICON_SIZE - 12,
  },
  warningBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.danger ?? '#c44',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.paper,
  },
  warningText: {
    color: '#fff',
    fontFamily: fonts.uiSemi,
    fontSize: 11,
    lineHeight: 12,
  },
  captionWrap: {
    position: 'absolute',
    bottom: 64,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
    marginBottom: 6,
  },
  caption: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg2,
  },
});
