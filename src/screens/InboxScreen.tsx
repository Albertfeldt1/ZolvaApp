import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChevronRight, PackageOpen, X } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Image,
  Pressable,
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
import { Stone } from '../components/Stone';
import { formatClock, formatToday } from '../lib/date';
import { useHasProvider, useInboxCleared, useInboxWaiting } from '../lib/hooks';
import type { MailProviderError } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';
import { colors, fonts, shadows } from '../theme';
import { translateProviderError } from '../utils/danish';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
  icloud: require('../../assets/logos/apple.png'),
};

const ARCHIVE_HINT_KEY = 'zolva.inbox.archive-fab-hint-shown';
const HINT_AUTOHIDE_MS = 5000;

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
};

export function InboxScreen({ onGoToSettings, onOpenMail, onOverDarkChange, onOpenIcloudSetup }: Props) {
  const today = useMemo(() => new Date(), []);
  const date = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);
  const { bottom: chromeBottom } = useChromeInsets();

  const { data: waiting, loading: waitingLoading, error: waitingError, providerErrors } = useInboxWaiting();
  const { data: cleared } = useInboxCleared();
  const hasProvider = useHasProvider();

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
  const [hintVisible, setHintVisible] = useState(false);

  // Inbox no longer has a dark section, so the chrome pill should always be
  // in its light mode when this screen mounts. Report once on mount and clear
  // on unmount so other screens aren't stuck in dark state after leaving here.
  useEffect(() => {
    onOverDarkChange?.(false);
    return () => onOverDarkChange?.(false);
  }, [onOverDarkChange]);

  // First-launch tooltip pointing at the archive FAB. Non-blocking: reads the
  // flag after mount, shows for 5s, marks flag on show so we only ever nag once.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(ARCHIVE_HINT_KEY).then((raw) => {
      if (cancelled || raw) return;
      setHintVisible(true);
      AsyncStorage.setItem(ARCHIVE_HINT_KEY, '1').catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hintVisible) return;
    const t = setTimeout(() => setHintVisible(false), HINT_AUTOHIDE_MS);
    return () => clearTimeout(t);
  }, [hintVisible]);

  const openArchive = () => {
    setHintVisible(false);
    setArchiveOpen(true);
  };

  return (
    <View style={styles.flex}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom + 96 }]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
      >
        <View style={styles.hero}>
          <View style={styles.heroTopRow}>
            <Text style={styles.eyebrow}>{`Indbakke · ${date.weekdayShort} ${clock}`}</Text>
          </View>
          <Text style={styles.heroH1}>Indbakke</Text>

          <View style={styles.statsRow}>
            <View>
              <CountUp to={waiting.length} style={styles.statBig} />
              <Text style={styles.statLabel}>Venter på dig</Text>
            </View>
            <View style={styles.statDivider} />
            <View>
              <CountUp to={cleared.count} style={styles.statMid} />
              <Text style={styles.statLabel}>Klaret for dig</Text>
            </View>
          </View>
        </View>

        {icloudExpired && (
          <Pressable
            style={styles.expiredBanner}
            onPress={() => onOpenIcloudSetup?.(icloudExpiredEmail ?? undefined)}
            accessibilityRole="button"
          >
            <Text style={styles.expiredBannerText}>
              Apple afviste adgangskoden — iCloud-mails vises ikke. Tryk for at genindtaste.
            </Text>
          </Pressable>
        )}

        {needsMicrosoftReauth && (
          <Pressable
            style={styles.expiredBanner}
            onPress={() => { void signInWithMicrosoft(); }}
            accessibilityRole="button"
          >
            <Text style={styles.expiredBannerText}>
              Microsoft-forbindelsen er udløbet — Outlook-mails vises ikke. Tryk for at logge ind igen.
            </Text>
          </Pressable>
        )}

        {needsGoogleReauth && (
          <Pressable
            style={styles.expiredBanner}
            onPress={() => { void signInWithGoogle(); }}
            accessibilityRole="button"
          >
            <Text style={styles.expiredBannerText}>
              Google-forbindelsen er udløbet — Gmail vises ikke. Tryk for at logge ind igen.
            </Text>
          </Pressable>
        )}

        {softFailures.map((e) => (
          <View key={e.provider} style={styles.softBanner}>
            <Text style={styles.softBannerText}>{providerFailureCopy(e)}</Text>
          </View>
        ))}

        <View style={styles.list}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Venter på dig</Text>
            <Text style={styles.sectionMeta}>{waiting.length}</Text>
          </View>
          <View style={styles.inkRule} />
          {waiting.length === 0 ? (
            waitingLoading && hasProvider && !waitingError ? (
              <View>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </View>
            ) : hasProvider ? (
              (() => {
                const err = waitingError ? translateProviderError(waitingError) : null;
                const isAuth = err?.kind === 'auth';
                return (
                  <EmptyState
                    mood="calm"
                    title={
                      err
                        ? err.kind === 'network'
                          ? 'Ingen forbindelse'
                          : 'Kunne ikke hente indbakke'
                        : 'Indbakken er tom'
                    }
                    body={
                      // "Perfekt timing" replaces the Anglicism "God timing". Triggered when the
                      // inbox has zero waiting mails — the intent is "lucky moment that nothing's
                      // waiting", not "take a break". "Timing" is a naturalised loanword in Danish.
                      err ? err.message : 'Intet venter på dig lige nu. Perfekt timing.'
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
            waiting.map((m, i) => (
              <Pressable
                key={m.id}
                onPress={() => onOpenMail(m)}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 && styles.rowBorder,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.avatarWrap}>
                  <Avatar initials={m.initials} tone={m.tone} />
                  {PROVIDER_LOGOS[m.provider] != null && (
                    <View style={styles.providerBadge}>
                      <Image
                        source={PROVIDER_LOGOS[m.provider]}
                        style={styles.providerLogo}
                        resizeMode="contain"
                      />
                    </View>
                  )}
                </View>
                <View style={styles.rowBody}>
                  <View style={styles.rowTopLine}>
                    <Text style={styles.sender} numberOfLines={1} ellipsizeMode="tail">{m.from}</Text>
                    <Text style={styles.time} numberOfLines={1}>{m.time}</Text>
                  </View>
                  <Text style={styles.subject} numberOfLines={2}>{m.subject}</Text>
                  {m.aiDraft && (
                    <View style={styles.draft}>
                      <Stone size={22} mood="thinking" />
                      <Text style={styles.draftText}>{m.aiDraft}</Text>
                    </View>
                  )}
                </View>
                <ChevronRight size={18} color={colors.fg4} strokeWidth={1.75} />
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>

      <View
        pointerEvents="box-none"
        style={[styles.fabWrap, { bottom: chromeBottom + 14 }]}
      >
        {hintVisible && (
          <Pressable
            onPress={() => setHintVisible(false)}
            style={styles.hintBubble}
            accessibilityRole="button"
            accessibilityLabel="Luk hint"
          >
            <Text style={styles.hintText}>Arkiverede mails findes her nu</Text>
            <View style={styles.hintClose}>
              <X size={12} color={colors.paperOn75} strokeWidth={2} />
            </View>
            <View style={styles.hintTail} />
          </Pressable>
        )}
        <Pressable
          onPress={openArchive}
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          accessibilityRole="button"
          accessibilityLabel="Åbn arkiv"
          hitSlop={8}
        >
          <PackageOpen size={20} color={colors.paper} strokeWidth={1.75} />
        </Pressable>
      </View>

      <ArchiveModal
        visible={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        onOpenMail={onOpenMail}
      />
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
  heroTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12,
    fontFamily: fonts.displayItalic,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
    color: colors.ink,
  },
  statsRow: { marginTop: 16, flexDirection: 'row', alignItems: 'flex-end', gap: 18 },
  statBig: {
    fontFamily: fonts.display, fontSize: 64, letterSpacing: -3.2, lineHeight: 68, color: colors.ink,
  },
  statMid: {
    fontFamily: fonts.display, fontSize: 36, letterSpacing: -1.08, lineHeight: 40, color: colors.ink,
  },
  statLabel: {
    marginTop: 4, fontFamily: fonts.uiSemi, fontSize: 11,
    letterSpacing: 0.88, textTransform: 'uppercase', color: colors.fg3,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth, alignSelf: 'stretch',
    backgroundColor: colors.line, marginBottom: 6,
  },

  expiredBanner: {
    marginHorizontal: 20, marginTop: 12,
    backgroundColor: colors.warningSoft, padding: 12, borderRadius: 8,
  },
  expiredBannerText: {
    fontFamily: fonts.ui, fontSize: 13, lineHeight: 19, color: colors.warningInk,
  },
  softBanner: {
    marginHorizontal: 20, marginTop: 8,
    backgroundColor: colors.line, padding: 10, borderRadius: 8,
  },
  softBannerText: {
    fontFamily: fonts.ui, fontSize: 12.5, lineHeight: 18, color: colors.fg2,
  },

  list: { paddingHorizontal: 20, paddingTop: 28 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', marginBottom: 4,
  },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  sectionMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  inkRule: { height: 1, backgroundColor: colors.ink, marginBottom: 2 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 14 },
  avatarWrap: { position: 'relative' },
  providerBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 16,
    height: 16,
    borderRadius: 999,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  providerLogo: { width: 11, height: 11 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowPressed: { opacity: 0.6 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTopLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  // flexShrink lets a long sender ellipsize instead of pushing the time
  // element off the right edge into the chevron.
  sender: { flexShrink: 1, fontFamily: fonts.uiSemi, fontSize: 14, color: colors.ink },
  time: { flexShrink: 0, fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  subject: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13.5, color: colors.ink },
  draft: { marginTop: 8, flexDirection: 'row', gap: 8, alignItems: 'center' },
  draftText: { flex: 1, fontFamily: 'Inter_500Medium_Italic', fontSize: 12.5, color: colors.fg2 },

  fabWrap: {
    position: 'absolute',
    right: 20,
    alignItems: 'flex-end',
    gap: 10,
  },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: colors.sage,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.fab,
  },
  fabPressed: { opacity: 0.88 },
  hintBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 10,
    borderRadius: 14,
    backgroundColor: colors.ink,
    maxWidth: 260,
    ...shadows.fab,
  },
  hintText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12.5,
    color: colors.paper,
    flexShrink: 1,
  },
  hintClose: {
    width: 20,
    height: 20,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(246,241,232,0.14)',
  },
  hintTail: {
    position: 'absolute',
    right: 14,
    bottom: -5,
    width: 10,
    height: 10,
    backgroundColor: colors.ink,
    transform: [{ rotate: '45deg' }],
  },
});
