// src/components/TrialNudges.tsx
//
// Today-screen billing nudge surfaces (billing #4).
// Visual language mirrors BriefBanner: same theme tokens, same spacing idioms,
// same card container so both cards look native to the Today feed.

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { useEntitlement } from '../lib/hooks';
import {
  presentPaywallIfNeeded,
} from '../lib/paywall';
import {
  markSkipperNudgeDismissed,
  readPitchRecord,
  readSkipperNudgeDismissed,
  skipperNudgeEligible,
  trialEndingBannerVisible,
} from '../lib/trial-nudges';
import { colors, fonts } from '../theme';

// ---------------------------------------------------------------------------
// SkipperNudgeCard — one-time "try Pro" card for users who skipped the pitch
// ---------------------------------------------------------------------------

export function SkipperNudgeCard() {
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const entResult = useEntitlement();
  const ent = entResult.data;

  const [visible, setVisible] = useState(false);
  const presenting = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    if (!uid || entResult.loading) {
      setVisible(false);
      return;
    }
    void Promise.all([
      readPitchRecord(uid),
      readSkipperNudgeDismissed(uid),
    ]).then(([pitch, dismissed]) => {
      if (cancelled) return;
      setVisible(
        skipperNudgeEligible({
          tier: ent.tier,
          pitch,
          dismissed,
          now: new Date(),
        }),
      );
    });
    return () => { cancelled = true; };
  }, [uid, ent.tier, entResult.loading]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  if (!visible) return null;

  const dismiss = async () => {
    if (mountedRef.current) {
      setVisible(false);
    }
    if (uid) await markSkipperNudgeDismissed(uid);
  };

  const handlePrimary = async () => {
    if (presenting.current) return;
    presenting.current = true;
    try {
      const entitled = await presentPaywallIfNeeded('pro');
      if (entitled) void dismiss();
    } finally {
      presenting.current = false;
    }
  };

  return (
    <View style={styles.card} accessibilityLabel="trial-skipper-nudge">
      <Text style={styles.eyebrow}>Pro</Text>
      <Text style={styles.headline}>Zolva har holdt øje for dig i et par dage</Text>
      <Text style={styles.body}>
        Prøv Pro gratis — autonome handlinger, ubegrænset chat og mere.
      </Text>
      <View style={styles.buttonRow}>
        <Pressable
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
          onPress={() => { void handlePrimary(); }}
          accessibilityRole="button"
          accessibilityLabel="Prøv Pro gratis"
        >
          <Text style={styles.primaryBtnText}>Prøv Pro</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed]}
          onPress={() => { void dismiss(); }}
          accessibilityRole="button"
          accessibilityLabel="Nej tak, behold gratis-planen"
        >
          <Text style={styles.secondaryBtnText}>Nej tak</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// TrialEndingBanner — lightweight banner during the final 48 h of a trial
// ---------------------------------------------------------------------------

export function TrialEndingBanner() {
  const entResult = useEntitlement();
  const ent = entResult.data;

  if (!trialEndingBannerVisible(ent, new Date())) return null;

  return (
    <View style={styles.banner} accessibilityLabel="trial-ending-banner">
      <Text style={styles.bannerText}>
        Din Pro-prøveperiode slutter om mindre end 2 dage.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles — reuse BriefBanner tokens verbatim
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // SkipperNudgeCard
  card: {
    margin: 16,
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.line,
    gap: 6,
  },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  headline: {
    fontFamily: fonts.displayItalic,
    fontSize: 22,
    letterSpacing: -0.32,
    color: colors.ink,
    marginTop: 4,
  },
  body: {
    fontFamily: fonts.ui,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.fg2,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  primaryBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.ink,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontFamily: fonts.monoSemi,
    fontSize: 13,
    letterSpacing: 0.4,
    color: '#FFFFFF',
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
  },
  secondaryBtnText: {
    fontFamily: fonts.monoSemi,
    fontSize: 13,
    letterSpacing: 0.4,
    color: colors.fg2,
  },
  btnPressed: { opacity: 0.75 },

  // TrialEndingBanner
  banner: {
    marginHorizontal: 16,
    marginBottom: 4,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.sageSoft,
    borderWidth: 1,
    borderColor: colors.sageDim,
  },
  bannerText: {
    fontFamily: fonts.ui,
    fontSize: 13.5,
    lineHeight: 19,
    color: colors.sageDeep,
  },
});
