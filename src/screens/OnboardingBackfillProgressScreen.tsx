// src/screens/OnboardingBackfillProgressScreen.tsx
//
// Loading screen between intro Start tap and the review screen. Polls the
// backfill-status edge function and renders one floating logo per active
// (provider × kind) job. Each icon's state machine is wired to the actual
// fetch lifecycle: drifts in from the edge → orbits the Stone while the
// worker runs → absorbed into the Stone on success, or settles muted at
// the edge with a warning badge on failure. Stone has an idle breathing
// animation throughout and pulses on completion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Image, ImageSourcePropType, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Stone } from '../components/Stone';
import { fetchBackfillStatus, type BackfillJob } from '../lib/onboarding-backfill';
import { colors, fonts } from '../theme';

type ServiceId = 'google:mail' | 'google:calendar' | 'microsoft:mail' | 'microsoft:calendar';

type IconStatus = 'incoming' | 'absorbing' | 'absorbed' | 'failed';

type IconState = {
  status: IconStatus;
  startedAt: number; // for min-duration enforcement
};

const SERVICE_META: Record<ServiceId, { logo: ImageSourcePropType; label: string }> = {
  'google:mail': { logo: require('../../assets/logos/gmail.png'), label: 'Gmail' },
  'google:calendar': { logo: require('../../assets/logos/google-calendar.png'), label: 'Google Kalender' },
  'microsoft:mail': { logo: require('../../assets/logos/outlook-mail.png'), label: 'Outlook' },
  'microsoft:calendar': { logo: require('../../assets/logos/outlook-calendar.png'), label: 'Outlook Kalender' },
};

// Stable ordering keeps each icon at a predictable starting angle around
// the Stone — Gmail to the right, Outlook bottom-left, etc.
const SERVICE_ORDER: ServiceId[] = [
  'google:mail',
  'microsoft:mail',
  'google:calendar',
  'microsoft:calendar',
];

const MIN_ICON_DURATION_MS = 1500; // user must see the journey
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_ATTEMPTS = 80; // ~2 minutes

const RADIUS_OFFSCREEN = 220;
const RADIUS_ORBIT = 92;
const RADIUS_FAILED = 138;

const DRIFT_IN_MS = 800;
const ORBIT_PERIOD_MS = 14000;
const ABSORB_MS = 500;
const FAILED_SETTLE_MS = 600;
const STONE_BREATHE_MS = 3200;
const STONE_PULSE_UP_MS = 380;
const STONE_PULSE_DOWN_MS = 620;
const COMPLETION_HOLD_MS = 950;

const STONE_SIZE = 132;

function jobKey(j: BackfillJob): ServiceId | null {
  if (j.provider === 'icloud') return null; // not in the backfill set yet
  if (j.kind !== 'mail' && j.kind !== 'calendar') return null;
  return `${j.provider}:${j.kind}` as ServiceId;
}

type Props = {
  onComplete: (failed: BackfillJob[]) => void;
};

export function OnboardingBackfillProgressScreen({ onComplete }: Props) {
  const [jobs, setJobs] = useState<BackfillJob[]>([]);
  const [iconStates, setIconStates] = useState<Partial<Record<ServiceId, IconState>>>({});
  const [reduceMotion, setReduceMotion] = useState(false);
  const completedRef = useRef(false);

  // Stone breathing + completion pulse.
  const stoneScale = useSharedValue(1);

  // Detect Reduce Motion once.
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (!cancelled) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { cancelled = true; sub.remove(); };
  }, []);

  // Idle breathing on the Stone — runs from mount until completion.
  useEffect(() => {
    if (reduceMotion) return; // crossfade-only mode keeps Stone static
    stoneScale.value = withRepeat(
      withSequence(
        withTiming(1.045, { duration: STONE_BREATHE_MS, easing: Easing.inOut(Easing.sin) }),
        withTiming(1, { duration: STONE_BREATHE_MS, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );
    return () => { cancelAnimation(stoneScale); };
  }, [reduceMotion, stoneScale]);

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
        // Treat anything not-done as failed for the purposes of the
        // review-screen banner.
        onComplete(jobs.filter((j) => j.status !== 'done'));
      }
    };
    void poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // onComplete intentionally not in deps — we want a stable poller.
    // jobs read inside is intentionally a closure of the latest setJobs
    // result via the ref pattern below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reduce icon states from the latest jobs payload. The min-duration
  // gate sits here so a sub-500ms fetch still plays the full sequence.
  useEffect(() => {
    setIconStates((prev) => {
      const next: Partial<Record<ServiceId, IconState>> = { ...prev };
      const now = Date.now();
      for (const job of jobs) {
        const key = jobKey(job);
        if (!key) continue;
        const cur = next[key];
        const startedAt = cur?.startedAt ?? now;

        // Failed / cancelled — terminal, even if elapsed < min duration.
        if (job.status === 'failed' || job.status === 'cancelled') {
          if (cur?.status !== 'failed') next[key] = { status: 'failed', startedAt };
          continue;
        }

        // Done but not yet absorbed — gate on min duration so the user
        // sees the icon arc.
        if (job.status === 'done') {
          if (cur?.status === 'absorbed' || cur?.status === 'absorbing') continue;
          const elapsed = now - startedAt;
          if (elapsed >= MIN_ICON_DURATION_MS) {
            next[key] = { status: 'absorbing', startedAt };
          } else {
            // Hold as 'incoming' until elapsed catches up; the next
            // poll tick (1.5s later) will retry.
            if (!cur) next[key] = { status: 'incoming', startedAt };
          }
          continue;
        }

        // queued / running — show the orbiting icon.
        if (!cur) next[key] = { status: 'incoming', startedAt };
      }
      return next;
    });
  }, [jobs]);

  // Min-duration nudge: if all jobs report 'done' very quickly, the loop
  // above won't re-fire (no new poll deltas). Schedule a tick.
  useEffect(() => {
    const now = Date.now();
    const pending = Object.entries(iconStates).filter(
      ([, s]) => s.status === 'incoming' && jobs.some((j) => jobKey(j) === undefined ? false : `${j.provider}:${j.kind}` === undefined ? false : true),
    );
    // Just schedule a generic tick if any incoming job already reports done.
    const needsTick = jobs.some((j) => {
      const k = jobKey(j);
      if (!k) return false;
      const s = iconStates[k];
      return j.status === 'done' && s?.status === 'incoming' && now - s.startedAt < MIN_ICON_DURATION_MS;
    });
    if (!needsTick) return;
    const earliest = Math.min(
      ...jobs.flatMap((j) => {
        const k = jobKey(j);
        const s = k ? iconStates[k] : undefined;
        return s ? [MIN_ICON_DURATION_MS - (now - s.startedAt)] : [];
      }),
    );
    const id = setTimeout(() => {
      setIconStates((prev) => {
        const next = { ...prev };
        for (const j of jobs) {
          const k = jobKey(j);
          if (!k) continue;
          if (j.status === 'done' && next[k]?.status === 'incoming') {
            next[k] = { status: 'absorbing', startedAt: next[k]!.startedAt };
          }
        }
        return next;
      });
    }, Math.max(80, earliest));
    return () => clearTimeout(id);
  }, [iconStates, jobs]);

  // Completion: every visible icon is either 'absorbed' or 'failed'. Pulse
  // the Stone, then advance.
  useEffect(() => {
    if (completedRef.current) return;
    if (jobs.length === 0) return;
    const visible = SERVICE_ORDER.filter((id) => iconStates[id]);
    if (visible.length === 0) return;
    const allTerminal = visible.every(
      (id) => iconStates[id]!.status === 'absorbed' || iconStates[id]!.status === 'failed',
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
    const id = setTimeout(() => onComplete(failed), COMPLETION_HOLD_MS);
    return () => clearTimeout(id);
  }, [iconStates, jobs, reduceMotion, stoneScale, onComplete]);

  const onAbsorbed = useCallback((id: ServiceId) => {
    setIconStates((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return { ...prev, [id]: { ...cur, status: 'absorbed' } };
    });
  }, []);

  const stoneStyle = useAnimatedStyle(() => ({
    transform: [{ scale: stoneScale.value }],
  }));

  // Render order is stable; missing services just don't render. Each
  // icon gets a different starting angle so they don't pile up.
  const visibleIcons = useMemo(
    () => SERVICE_ORDER.filter((id) => iconStates[id] && iconStates[id]!.status !== 'absorbed'),
    [iconStates],
  );

  return (
    <View style={styles.flex}>
      <View style={styles.center}>
        <Animated.View style={[styles.stoneWrap, stoneStyle]} pointerEvents="none">
          <Stone mood="thinking" size={STONE_SIZE} />
        </Animated.View>
        {visibleIcons.map((id, i) => (
          <ServiceIcon
            key={id}
            id={id}
            baseAngleDeg={(i * 360) / Math.max(1, SERVICE_ORDER.length)}
            status={iconStates[id]!.status}
            reduceMotion={reduceMotion}
            onAbsorbed={onAbsorbed}
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

// ─── Service icon ──────────────────────────────────────────────────────

type ServiceIconProps = {
  id: ServiceId;
  baseAngleDeg: number;
  status: IconStatus;
  reduceMotion: boolean;
  onAbsorbed: (id: ServiceId) => void;
};

function ServiceIcon({ id, baseAngleDeg, status, reduceMotion, onAbsorbed }: ServiceIconProps) {
  const radius = useSharedValue(RADIUS_OFFSCREEN);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);
  const orbitAngle = useSharedValue(baseAngleDeg);
  const wobble = useSharedValue(0);
  const meta = SERVICE_META[id];

  // Drive entry on mount. The icon spawns off-screen, drifts in, and the
  // orbit + wobble loops kick in concurrently. Reduced motion: just fade
  // in at the orbit position; no orbit, no wobble.
  useEffect(() => {
    if (reduceMotion) {
      radius.value = RADIUS_ORBIT;
      opacity.value = withTiming(1, { duration: 240 });
      return;
    }
    opacity.value = withTiming(1, { duration: DRIFT_IN_MS });
    radius.value = withTiming(RADIUS_ORBIT, {
      duration: DRIFT_IN_MS,
      easing: Easing.out(Easing.cubic),
    });
    orbitAngle.value = withRepeat(
      withTiming(baseAngleDeg + 360, { duration: ORBIT_PERIOD_MS, easing: Easing.linear }),
      -1,
      false,
    );
    wobble.value = withDelay(
      Math.random() * 800,
      withRepeat(
        withSequence(
          withTiming(7, { duration: 1700, easing: Easing.inOut(Easing.sin) }),
          withTiming(-7, { duration: 1700, easing: Easing.inOut(Easing.sin) }),
        ),
        -1,
        false,
      ),
    );
    return () => {
      cancelAnimation(orbitAngle);
      cancelAnimation(wobble);
    };
    // baseAngleDeg / id are stable per icon.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // React to status transitions.
  useEffect(() => {
    if (status === 'absorbing') {
      cancelAnimation(orbitAngle);
      cancelAnimation(wobble);
      radius.value = withTiming(0, { duration: ABSORB_MS, easing: Easing.in(Easing.cubic) });
      scale.value = withTiming(0.18, { duration: ABSORB_MS, easing: Easing.in(Easing.cubic) });
      opacity.value = withTiming(0, { duration: ABSORB_MS }, (finished) => {
        if (finished) runOnJS(onAbsorbed)(id);
      });
      return;
    }
    if (status === 'failed') {
      cancelAnimation(orbitAngle);
      cancelAnimation(wobble);
      radius.value = withTiming(RADIUS_FAILED, { duration: FAILED_SETTLE_MS, easing: Easing.out(Easing.cubic) });
      opacity.value = withTiming(0.42, { duration: FAILED_SETTLE_MS });
    }
    // 'incoming' / 'absorbed' don't need explicit re-handling here — the
    // mount effect handles 'incoming', and 'absorbed' icons are unmounted
    // by the parent (filter on visibleIcons).
  }, [status, id, onAbsorbed, orbitAngle, wobble, radius, scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => {
    const angle = (orbitAngle.value * Math.PI) / 180;
    const x = Math.cos(angle) * radius.value;
    const y = Math.sin(angle) * radius.value + wobble.value;
    return {
      transform: [{ translateX: x }, { translateY: y }, { scale: scale.value }],
      opacity: opacity.value,
    };
  });

  return (
    <Animated.View style={[styles.iconAbs, animatedStyle]} pointerEvents="none">
      <View style={styles.iconCard}>
        <Image source={meta.logo} style={styles.iconImage} resizeMode="contain" />
      </View>
      {status === 'failed' && (
        <View style={styles.warningBadge}>
          <Text style={styles.warningText}>!</Text>
        </View>
      )}
    </Animated.View>
  );
}

const ICON_SIZE = 44;

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
