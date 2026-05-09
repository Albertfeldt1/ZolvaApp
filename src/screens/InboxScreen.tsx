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
import { archiveMailInline, deleteMailInline, refreshMailNow, useHasProvider, useInboxWaiting } from '../lib/hooks';
import type { MailProviderError } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';
import { SwipeableMailRow } from '../components/SwipeableMailRow';
import { translateProviderError } from '../utils/danish';
import { useTheme } from '../design/useTheme';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { TopBar } from '../design/primitives/TopBar';
import { Icon as DesignIcon } from '../design/primitives/Icon';
import { Stone } from '../design/primitives/Stone';
import { colors as legacyColors } from '../theme';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
  icloud: require('../../assets/logos/apple.png'),
};

function providerFailureCopy(e: MailProviderError): string {
  if (e.provider === 'icloud') {
    if (e.code === 'network' || e.code === 'timeout' || e.code === 'gateway-unavailable') {
      return 'Apple-mails kunne ikke hentes - netværket eller iCloud svarer ikke. Prøv igen om lidt.';
    }
    return 'Apple-mails kunne ikke hentes lige nu. Prøv igen om lidt.';
  }
  if (e.provider === 'microsoft') {
    return 'Outlook-mails kunne ikke hentes - prøv igen om lidt.';
  }
  return 'Gmail kunne ikke hentes - prøv igen om lidt.';
}

type Props = {
  onGoToSettings: () => void;
  onOpenMail: (mail: InboxMail) => void;
  onOverDarkChange?: (over: boolean) => void;
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  onOpenNotifications: () => void;
  onOpenSentMails: () => void;
  isActive?: boolean;
};

export function InboxScreen({ onGoToSettings, onOpenMail, onOverDarkChange, onOpenIcloudSetup, onOpenNotifications, onOpenSentMails, isActive = true }: Props) {
  const today = useMemo(() => new Date(), []);
  const { bottom: chromeBottom } = useChromeInsets();

  const { data: waiting, read, loading: waitingLoading, error: waitingError, providerErrors } = useInboxWaiting();
  const hasProvider = useHasProvider();

  const theme = useTheme();
  const { t, type, fonts, radius, spacing, surface } = theme;

  // Soft per-provider failures - when iCloud throws but Gmail succeeds (or
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
  // an access token - typically because `user_oauth_tokens` has no row for
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

  // Per-section collapse state. Tier 0 ("Haster") is always visible - no
  // toggle. Tier 1 stays open by default since that's the main inbox; the
  // bulk-noise tiers (2 newsletters, 3 auto-mails) and the read pile are
  // closed by default so a 100-mail mailbox doesn't swamp the screen.
  const [waitingOpen, setWaitingOpen] = useState(true);
  const [newslettersOpen, setNewslettersOpen] = useState(false);
  const [autoMailsOpen, setAutoMailsOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);

  const sections = useMemo(() => {
    const tier0: InboxMail[] = [];
    const tier1: InboxMail[] = [];
    const tier2: InboxMail[] = [];
    const tier3: InboxMail[] = [];
    for (const m of waiting) {
      if (m.tier === 0) tier0.push(m);
      else if (m.tier === 1) tier1.push(m);
      else if (m.tier === 2) tier2.push(m);
      else tier3.push(m);
    }
    return { tier0, tier1, tier2, tier3 };
  }, [waiting]);

  // Inbox no longer has a dark section, so the chrome pill should always be
  // in its light mode when this tab is visible. Tabs stay mounted across
  // switches, so we sync on isActive flips rather than mount/unmount.
  useEffect(() => {
    if (isActive) onOverDarkChange?.(false);
  }, [isActive, onOverDarkChange]);

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
          onSend={onOpenSentMails}
          onArchive={() => setArchiveOpen(true)}
          onBell={onOpenNotifications}
          onGear={onGoToSettings}
        />

        {/* Hero text block - wrapped in a soft glass backdrop. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}
          >
            <Text style={{ ...type.displayXL, color: t.ink }}>
              <CountUp to={waiting.length} style={{ ...type.displayXL, color: t.ink }} /> venter{'\n'}på dig.
            </Text>
            {waiting.length > 0 && (
              <Text style={{ ...type.body, color: t.ink2, marginTop: spacing.md - 2 }}>
                Sorteret efter hvor det haster.
              </Text>
            )}
          </GlassFrostedCard>
        </View>

        {/* Banners */}
        {icloudExpired && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => onOpenIcloudSetup?.(icloudExpiredEmail ?? undefined)} accessibilityRole="button">
              <View style={{ padding: spacing.cardPad, borderRadius: radius.cardSm, backgroundColor: legacyColors.warningSoft, borderWidth: 1, borderColor: 'rgba(138,111,26,0.18)' }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Apple afviste adgangskoden - iCloud-mails vises ikke. Tryk for at genindtaste.
                </Text>
              </View>
            </Pressable>
          </View>
        )}

        {needsMicrosoftReauth && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => { void signInWithMicrosoft(); }} accessibilityRole="button">
              <View style={{ padding: spacing.cardPad, borderRadius: radius.cardSm, backgroundColor: legacyColors.warningSoft, borderWidth: 1, borderColor: 'rgba(138,111,26,0.18)' }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Microsoft-forbindelsen er udløbet - Outlook-mails vises ikke. Tryk for at logge ind igen.
                </Text>
              </View>
            </Pressable>
          </View>
        )}

        {needsGoogleReauth && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <Pressable onPress={() => { void signInWithGoogle(); }} accessibilityRole="button">
              <View style={{ padding: spacing.cardPad, borderRadius: radius.cardSm, backgroundColor: legacyColors.warningSoft, borderWidth: 1, borderColor: 'rgba(138,111,26,0.18)' }}>
                <Text style={{ ...type.bodySm, color: t.ink, fontWeight: '600' }}>
                  Google-forbindelsen er udløbet - Gmail vises ikke. Tryk for at logge ind igen.
                </Text>
              </View>
            </Pressable>
          </View>
        )}

        {softFailures.map((e) => (
          <View key={e.provider} style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
            <View style={{ padding: spacing.cardPad, borderRadius: radius.cardSm, backgroundColor: legacyColors.warningSoft, borderWidth: 1, borderColor: 'rgba(138,111,26,0.18)' }}>
              <Text style={{ ...type.bodySm, color: t.ink }}>
                {providerFailureCopy(e)}
              </Text>
            </View>
          </View>
        ))}

        {/* Mail row renderer - used by every section. `muted` softens
            already-read or low-priority rows (lighter type, reduced
            opacity) so the eye glides over them. */}
        {(() => {
          const renderRow = (m: InboxMail, muted: boolean) => (
            <SwipeableMailRow
              key={m.id}
              onArchive={() => { void archiveMailInline(m.id, m.provider); }}
              onDelete={() => { void deleteMailInline(m.id, m.provider); }}
            >
            <GlassFrostedCard
              style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad, opacity: muted ? 0.75 : 1 }}
            >
              <Pressable
                onPress={() => onOpenMail(m)}
                style={({ pressed }) => [{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }, pressed && { opacity: 0.6 }]}
              >
                <View style={{ position: 'relative', opacity: muted ? 0.7 : 1 }}>
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
                    <Text style={{ fontFamily: muted ? fonts.ui : fonts.uiBold, fontSize: type.bodySm.fontSize, color: muted ? t.ink2 : t.ink, flex: 0, flexShrink: 1 }} numberOfLines={1}>{m.from}</Text>
                    <View style={{ flex: 1 }} />
                    <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none' }}>{m.time}</Text>
                  </View>
                  <Text style={{ fontFamily: muted ? fonts.ui : fonts.uiBold, fontSize: type.bodySm.fontSize, color: muted ? t.ink3 : t.ink, marginTop: 2 }} numberOfLines={2}>{m.subject}</Text>
                  {!muted && m.aiDraft && (
                    <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'flex-start' }}>
                      <Stone size={22} jumpOnTap={false} />
                      <Text style={{ ...type.caption, color: t.ink3, flex: 1 }} numberOfLines={2}>{m.aiDraft}</Text>
                    </View>
                  )}
                </View>
                <DesignIcon.chev size={14} color={t.ink4} />
              </Pressable>
            </GlassFrostedCard>
            </SwipeableMailRow>
          );

          // Collapsible section header. Tap toggles open/closed; chev
          // rotates to give a click affordance. Tier 0 ("Haster") never
          // collapses, so callers omit `onToggle` to render a static header.
          const renderHeader = (
            title: string,
            count: number,
            opts?: { open?: boolean; onToggle?: () => void },
          ) => {
            const isStatic = !opts?.onToggle;
            const Wrapper: React.ComponentType<{ children: React.ReactNode }> = isStatic
              ? ({ children }) => <View>{children}</View>
              : ({ children }) => (
                  <Pressable
                    onPress={opts!.onToggle}
                    accessibilityRole="button"
                    style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                  >
                    {children}
                  </Pressable>
                );
            return (
              <Wrapper>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                  <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>{title}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
                    <Text style={{ ...type.eyebrow, color: t.ink3 }}>{count}</Text>
                    {!isStatic && (
                      <View style={{ transform: [{ rotate: opts?.open ? '90deg' : '0deg' }] }}>
                        <DesignIcon.chev size={12} color={t.ink3} />
                      </View>
                    )}
                  </View>
                </View>
              </Wrapper>
            );
          };

          // Empty / loading / no-provider state - only when the entire
          // waiting list is empty AND we're not just skipping a section
          // because it has zero items.
          if (waiting.length === 0) {
            return (
              <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                {renderHeader('Venter på dig', 0)}
                {waitingLoading && hasProvider && !waitingError ? (
                  <View style={{ gap: spacing.sm }}>
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                    <SkeletonRow />
                  </View>
                ) : hasProvider ? (
                  (() => {
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
                )}
              </View>
            );
          }

          return (
            <>
              {/* Tier 0 - always visible, no toggle. */}
              {sections.tier0.length > 0 && (
                <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                  {renderHeader('Haster', sections.tier0.length)}
                  <View style={{ gap: spacing.sm }}>
                    {sections.tier0.map((m) => renderRow(m, false))}
                  </View>
                </View>
              )}
              {/* Tier 1 - main inbox, collapsible, default open. */}
              {sections.tier1.length > 0 && (
                <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                  {renderHeader('Venter på dig', sections.tier1.length, {
                    open: waitingOpen,
                    onToggle: () => setWaitingOpen((v) => !v),
                  })}
                  {waitingOpen && (
                    <View style={{ gap: spacing.sm }}>
                      {sections.tier1.map((m) => renderRow(m, false))}
                    </View>
                  )}
                </View>
              )}
              {/* Tier 2 - newsletters, collapsible, default closed. */}
              {sections.tier2.length > 0 && (
                <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                  {renderHeader('Nyhedsbreve', sections.tier2.length, {
                    open: newslettersOpen,
                    onToggle: () => setNewslettersOpen((v) => !v),
                  })}
                  {newslettersOpen && (
                    <View style={{ gap: spacing.sm }}>
                      {sections.tier2.map((m) => renderRow(m, true))}
                    </View>
                  )}
                </View>
              )}
              {/* Tier 3 - auto-mails / no-reply, collapsible, default closed. */}
              {sections.tier3.length > 0 && (
                <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                  {renderHeader('Notifikationer', sections.tier3.length, {
                    open: autoMailsOpen,
                    onToggle: () => setAutoMailsOpen((v) => !v),
                  })}
                  {autoMailsOpen && (
                    <View style={{ gap: spacing.sm }}>
                      {sections.tier3.map((m) => renderRow(m, true))}
                    </View>
                  )}
                </View>
              )}
              {/* Læst - collapsible, default closed. */}
              {read.length > 0 && (
                <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                  {renderHeader('Læst', read.length, {
                    open: readOpen,
                    onToggle: () => setReadOpen((v) => !v),
                  })}
                  {readOpen && (
                    <View style={{ gap: spacing.sm }}>
                      {read.map((m) => renderRow(m, true))}
                    </View>
                  )}
                </View>
              )}
            </>
          );
        })()}
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
