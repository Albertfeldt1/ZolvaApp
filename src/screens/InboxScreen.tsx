import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../lib/auth';
import { loadCredential } from '../lib/icloud-credentials';
import { ArchiveModal } from '../components/ArchiveModal';
import { Avatar } from '../components/Avatar';
import { CountUp } from '../components/CountUp';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { SkeletonRow } from '../components/Skeleton';
import { formatClock, formatToday } from '../lib/date';
import { refreshMailNow, useHasProvider, useInboxWaiting } from '../lib/hooks';
import type { MailProviderError } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';
import { translateProviderError } from '../utils/danish';
import { useTheme } from '../design/useTheme';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { TopBar } from '../design/primitives/TopBar';
import { Icon as DesignIcon } from '../design/primitives/Icon';
import { Stone } from '../design/primitives/Stone';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
  icloud: require('../../assets/logos/apple.png'),
};

function providerFailureCopy(e: MailProviderError): string {
  if (e.provider === 'icloud') {
    if (e.code === 'network' || e.code === 'timeout' || e.code === 'gateway-unavailable') {
      return 'Apple-mails kunne ikke hentes — netværket eller iCloud svarer ikke. Prøv igen om lidt.';
    }
    return 'Apple-mails kunne ikke hentes lige nu. Prøv igen om lidt.';
  }
  if (e.provider === 'microsoft') {
    return 'Outlook-mails kunne ikke hentes — prøv igen om lidt.';
  }
  return 'Gmail kunne ikke hentes — prøv igen om lidt.';
}

type Props = {
  onGoToSettings: () => void;
  onOpenMail: (mail: InboxMail) => void;
  onOverDarkChange?: (over: boolean) => void;
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  onOpenNotifications: () => void;
};

export function InboxScreen({ onGoToSettings, onOpenMail, onOverDarkChange, onOpenIcloudSetup, onOpenNotifications }: Props) {
  const today = useMemo(() => new Date(), []);
  const { bottom: chromeBottom } = useChromeInsets();

  const { data: waiting, read, loading: waitingLoading, error: waitingError, providerErrors } = useInboxWaiting();
  const hasProvider = useHasProvider();

  const theme = useTheme();
  const { t, type, fonts, radius, spacing, surface } = theme;

  // Soft per-provider failures — when iCloud throws but Gmail succeeds (or
  // vice versa), `waitingError` stays null because the global "all failed"
  // condition isn't met. Without these banners the failed provider was
  // silently absent from the list. iCloud auth-failed has its own
  // (credential-rejected) banner above; suppress here to avoid doubling up.
  const softFailures = providerErrors.filter((e) => {
    if (e.provider === 'icloud') return e.code !== 'auth-failed' && e.code !== 'credential-rejected';
    return true;
  });

  const {
    user,
    initializing,
    googleAccessToken,
    microsoftAccessToken,
    googleRefreshingAtBoot,
    microsoftRefreshingAtBoot,
    signInWithGoogle,
    signInWithMicrosoft,
  } = useAuth();
  const userId = user?.id ?? '';

  // Provider-in-identity-but-no-token: the user signed in with this provider
  // (Supabase auth.identities row exists), but `silentRefresh` couldn't mint
  // an access token — typically because `user_oauth_tokens` has no row for
  // this user/provider (broker upsert never ran or failed). Without these
  // banners the missing provider was silently absent from the inbox and the
  // user had no path to recover short of full sign-out.
  const providers = (user?.app_metadata?.providers as string[] | undefined) ?? [];
  const needsMicrosoftReauth =
    !initializing && !microsoftRefreshingAtBoot && providers.includes('azure') && !microsoftAccessToken;
  const needsGoogleReauth =
    !initializing && !googleRefreshingAtBoot && providers.includes('google') && !googleAccessToken;

  const [icloudExpired, setIcloudExpired] = useState(false);
  const [icloudExpiredEmail, setIcloudExpiredEmail] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setIcloudExpired(false); return; }
    const refresh = () => {
      void loadCredential(userId).then((c) => {
        if (cancelled) return;
        setIcloudExpired(c.kind === 'invalid');
        setIcloudExpiredEmail(c.kind === 'invalid' ? c.credential.email : null);
      });
    };
    refresh();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => { cancelled = true; sub.remove(); };
  }, [userId]);

  const [archiveOpen, setArchiveOpen] = useState(false);

  // Inbox no longer has a dark section, so the chrome pill should always be
  // in its light mode when this screen mounts. Report once on mount and clear
  // on unmount so other screens aren't stuck in dark state after leaving here.
  useEffect(() => {
    onOverDarkChange?.(false);
    return () => onOverDarkChange?.(false);
  }, [onOverDarkChange]);

  // Pull-to-refresh: latch on the user gesture, hold the spinner until the
  // backing fetch settles (waitingLoading flips back to false), then release.
  // Avoids a fixed timeout that could snap closed mid-fetch on slow networks.
  const [pullActive, setPullActive] = useState(false);
  const onRefresh = useCallback(() => {
    setPullActive(true);
    refreshMailNow();
  }, []);
  useEffect(() => {
    if (pullActive && !waitingLoading) setPullActive(false);
  }, [pullActive, waitingLoading]);

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingBottom: chromeBottom + 96 }}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl
            refreshing={pullActive}
            onRefresh={onRefresh}
            tintColor={t.ink3}
          />
        }
      >
        {/* TopBar */}
        <TopBar
          eyebrow="INDBAKKE"
          onBell={onOpenNotifications}
          onGear={onGoToSettings}
        />

        {/* Hero text block — wrapped in a soft glass backdrop. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
            <Text style={{ ...type.displayXL, color: t.ink }}>
              <CountUp to={waiting.length} style={{ ...type.displayXL, color: t.ink }} /> venter{'\n'}på dig.
            </Text>
            {(waiting.length + read.length) > 0 && (
              <Text style={{ ...type.body, color: t.ink2, marginTop: spacing.md - 2 }}>
                <CountUp to={waiting.length + read.length} /> mails i alt. Jeg har sorteret dem efter, hvad der haster.
              </Text>
            )}
          </GlassFrostedCard>
        </View>

        {/* Banners */}
        {icloudExpired && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => onOpenIcloudSetup?.(icloudExpiredEmail ?? undefined)} accessibilityRole="button">
              <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Apple afviste adgangskoden — iCloud-mails vises ikke. Tryk for at genindtaste.
                </Text>
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {needsMicrosoftReauth && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => { void signInWithMicrosoft(); }} accessibilityRole="button">
              <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Microsoft-forbindelsen er udløbet — Outlook-mails vises ikke. Tryk for at logge ind igen.
                </Text>
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {needsGoogleReauth && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => { void signInWithGoogle(); }} accessibilityRole="button">
              <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Google-forbindelsen er udløbet — Gmail vises ikke. Tryk for at logge ind igen.
                </Text>
              </GlassFrostedCard>
            </Pressable>
          </View>
        )}

        {softFailures.map((e) => (
          <View key={e.provider} style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <GlassFrostedCard overlay={surface.warningTint} style={{ padding: spacing.cardPad }}>
              <Text style={{ ...type.bodySm, color: t.ink }}>
                {providerFailureCopy(e)}
              </Text>
            </GlassFrostedCard>
          </View>
        ))}

        {/* "Venter på dig" section */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
            <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>Venter på dig</Text>
            <CountUp to={waiting.length} style={{ ...type.eyebrow, color: t.ink3 }} />
          </View>

          {waiting.length === 0 ? (
            waitingLoading && hasProvider && !waitingError ? (
              <View style={{ gap: spacing.sm }}>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </View>
            ) : hasProvider ? (
              (() => {
                // When per-provider banners are already showing the failure(s), the
                // empty-state error just duplicates them — and is less specific. Suppress
                // the error copy here and show a quieter "pull to refresh" hint instead.
                const anyProviderBanner =
                  icloudExpired || needsMicrosoftReauth || needsGoogleReauth || softFailures.length > 0;
                const dedupErr = !!waitingError && anyProviderBanner;
                const err = !dedupErr && waitingError ? translateProviderError(waitingError) : null;
                const isAuth = err?.kind === 'auth';
                return (
                  <EmptyState
                    mood="calm"
                    title={
                      err
                        ? err.kind === 'network'
                          ? 'Ingen forbindelse'
                          : 'Kunne ikke hente indbakke'
                        : dedupErr
                          ? 'Træk ned for at prøve igen'
                          : 'Indbakken er tom'
                    }
                    body={
                      // "Perfekt timing" replaces the Anglicism "God timing". Triggered when the
                      // inbox has zero waiting mails — the intent is "lucky moment that nothing's
                      // waiting", not "take a break". "Timing" is a naturalised loanword in Danish.
                      err
                        ? err.message
                        : dedupErr
                          ? undefined
                          : 'Intet venter på dig lige nu. Perfekt timing.'
                    }
                    ctaLabel={isAuth ? 'Gå til indstillinger' : undefined}
                    onCta={isAuth ? onGoToSettings : undefined}
                  />
                );
              })()
            ) : (
              <EmptyState
                mood="calm"
                title="Indbakken er tom"
                body="Forbind Gmail eller Outlook, så viser jeg de mails der venter på dig."
                ctaLabel="Forbind indbakke"
                onCta={onGoToSettings}
              />
            )
          ) : (
            <View style={{ gap: spacing.sm }}>
              {waiting.map((m) => (
                <GlassFrostedCard key={m.id} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
                  <Pressable
                    onPress={() => onOpenMail(m)}
                    style={({ pressed }) => [{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }, pressed && { opacity: 0.6 }]}
                  >
                    <View style={{ position: 'relative' }}>
                      <Avatar initials={m.initials} tone={m.tone} />
                      {PROVIDER_LOGOS[m.provider] != null && (
                        <View style={{
                          position: 'absolute',
                          bottom: -2,
                          right: -2,
                          width: 16,
                          height: 16,
                          borderRadius: radius.pill,
                          backgroundColor: t.paper,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}>
                          <Image
                            source={PROVIDER_LOGOS[m.provider]}
                            style={{ width: 12, height: 12 }}
                            resizeMode="contain"
                          />
                        </View>
                      )}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                        <Text style={{ fontFamily: fonts.uiBold, fontSize: type.bodySm.fontSize, color: t.ink, flex: 0, flexShrink: 1 }} numberOfLines={1}>{m.from}</Text>
                        <View style={{ flex: 1 }} />
                        <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none' }}>{m.time}</Text>
                      </View>
                      <Text style={{ fontFamily: fonts.uiBold, fontSize: type.bodySm.fontSize, color: t.ink, marginTop: 2 }} numberOfLines={2}>{m.subject}</Text>
                      {m.aiDraft && (
                        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start' }}>
                          <Stone size={22} jumpOnTap={false} />
                          <Text style={{ ...type.caption, color: t.ink3, flex: 1 }} numberOfLines={2}>{m.aiDraft}</Text>
                        </View>
                      )}
                    </View>
                    <DesignIcon.chev size={14} color={t.ink4} />
                  </Pressable>
                </GlassFrostedCard>
              ))}
            </View>
          )}
        </View>

        {/* "Læst" section */}
        {read.length > 0 && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
              <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>Læst</Text>
              <CountUp to={read.length} style={{ ...type.eyebrow, color: t.ink3 }} />
            </View>
            <View style={{ gap: spacing.sm }}>
              {read.map((m) => (
                <GlassFrostedCard key={m.id} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad, opacity: 0.75 }}>
                  <Pressable
                    onPress={() => onOpenMail(m)}
                    style={({ pressed }) => [{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }, pressed && { opacity: 0.6 }]}
                  >
                    <View style={{ position: 'relative', opacity: 0.7 }}>
                      <Avatar initials={m.initials} tone={m.tone} />
                      {PROVIDER_LOGOS[m.provider] != null && (
                        <View style={{
                          position: 'absolute',
                          bottom: -2,
                          right: -2,
                          width: 16,
                          height: 16,
                          borderRadius: radius.pill,
                          backgroundColor: t.paper,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}>
                          <Image
                            source={PROVIDER_LOGOS[m.provider]}
                            style={{ width: 12, height: 12 }}
                            resizeMode="contain"
                          />
                        </View>
                      )}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                        <Text style={{ fontFamily: fonts.ui, fontSize: type.bodySm.fontSize, color: t.ink2, flex: 0, flexShrink: 1 }} numberOfLines={1}>{m.from}</Text>
                        <View style={{ flex: 1 }} />
                        <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none' }}>{m.time}</Text>
                      </View>
                      <Text style={{ fontFamily: fonts.ui, fontSize: type.bodySm.fontSize, color: t.ink3, marginTop: 2 }} numberOfLines={2}>{m.subject}</Text>
                    </View>
                    <DesignIcon.chev size={14} color={t.ink4} />
                  </Pressable>
                </GlassFrostedCard>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <ArchiveModal
        visible={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onOpenMail={onOpenMail}
      />
    </View>
  );
}

// Keep a minimal StyleSheet for any remaining style references
const styles = StyleSheet.create({});
