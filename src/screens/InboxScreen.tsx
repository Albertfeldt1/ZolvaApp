import { Check, ChevronRight } from 'lucide-react-native';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  Image,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Avatar } from '../components/Avatar';
import { CountUp } from '../components/CountUp';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { SkeletonRow } from '../components/Skeleton';
import { Stone } from '../components/Stone';
import { formatClock, formatToday } from '../lib/date';
import { useHasProvider, useInboxCleared, useInboxWaiting } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';
import { colors, fonts } from '../theme';
import { translateProviderError } from '../utils/danish';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
};

type Props = {
  onGoToSettings: () => void;
  onOpenMail: (mail: InboxMail) => void;
  onOverDarkChange?: (over: boolean) => void;
};

const PILL_CLEARANCE = 76;

export function InboxScreen({ onGoToSettings, onOpenMail, onOverDarkChange }: Props) {
  const today = useMemo(() => new Date(), []);
  const date = useMemo(() => formatToday(today), [today]);
  const clock = useMemo(() => formatClock(today), [today]);
  const { bottom: chromeBottom } = useChromeInsets();

  const { data: waiting, loading: waitingLoading, error: waitingError } = useInboxWaiting();
  const { data: cleared } = useInboxCleared();
  const hasProvider = useHasProvider();

  const scrollYRef = useRef(0);
  const viewportHRef = useRef(0);
  const darkYRef = useRef<number | null>(null);
  const lastOverRef = useRef<boolean | null>(null);

  const checkOverDark = () => {
    if (!onOverDarkChange || darkYRef.current === null || viewportHRef.current === 0) return;
    const darkTop = darkYRef.current - scrollYRef.current;
    const pillTop = viewportHRef.current - PILL_CLEARANCE;
    const over = darkTop < pillTop;
    if (over !== lastOverRef.current) {
      lastOverRef.current = over;
      onOverDarkChange(over);
    }
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
    checkOverDark();
  };

  useEffect(() => {
    return () => {
      if (onOverDarkChange && lastOverRef.current) onOverDarkChange(false);
    };
  }, [onOverDarkChange]);

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={(e) => {
        viewportHRef.current = e.nativeEvent.layout.height;
        checkOverDark();
      }}
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
                <View style={styles.providerBadge}>
                  <Image
                    source={PROVIDER_LOGOS[m.provider]}
                    style={styles.providerLogo}
                    resizeMode="contain"
                  />
                </View>
              </View>
              <View style={styles.rowBody}>
                <View style={styles.rowTopLine}>
                  <Text style={styles.sender}>{m.from}</Text>
                  <Text style={styles.time}>{m.time}</Text>
                </View>
                <Text style={styles.subject}>{m.subject}</Text>
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

      <View
        style={[styles.dark, { paddingBottom: chromeBottom }]}
        onLayout={(e) => {
          darkYRef.current = e.nativeEvent.layout.y;
          checkOverDark();
        }}
      >
        <View style={styles.darkHead}>
          <Text style={styles.darkTitle}>Klaret for dig</Text>
          <Text style={styles.darkMeta}>
            {cleared.count > 0 ? `${cleared.count} i dag` : '-'}
          </Text>
        </View>
        {cleared.items.length === 0 ? (
          <EmptyState
            dark
            mood="happy"
            title="Intet er ryddet endnu"
            body="Når jeg arkiverer eller besvarer mails for dig, dukker de op her."
          />
        ) : (
          <View style={{ gap: 10 }}>
            {cleared.items.map((m) => (
              <View key={m.id} style={styles.doneRow}>
                <Check size={14} color={colors.sageDim} strokeWidth={2.5} />
                <Text style={styles.doneLine}>
                  <Text style={styles.doneSender}>{m.from}</Text>
                  <Text style={styles.doneMeta}> · {m.note}</Text>
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  roundIcon: {
    width: 34, height: 34, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center',
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

  list: { paddingHorizontal: 20, paddingTop: 28 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', marginBottom: 4,
  },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  sectionMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  inkRule: { height: 1, backgroundColor: colors.ink, marginBottom: 2 },
  emptyText: {
    paddingVertical: 20,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },
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
  rowTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  sender: { fontFamily: fonts.uiSemi, fontSize: 14, color: colors.ink },
  time: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  subject: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13.5, color: colors.ink },
  draft: { marginTop: 8, flexDirection: 'row', gap: 8, alignItems: 'center' },
  draftText: { flex: 1, fontFamily: 'Inter_500Medium_Italic', fontSize: 12.5, color: colors.fg2 },

  dark: {
    marginTop: 28,
    paddingTop: 24,
    paddingHorizontal: 20,
    backgroundColor: colors.ink,
  },
  darkHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', marginBottom: 12,
  },
  darkTitle: {
    fontFamily: fonts.displayItalic, fontSize: 22,
    letterSpacing: -0.33, color: colors.paper,
  },
  darkMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.paperOn50 },
  darkEmpty: {
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 14,
    lineHeight: 21,
    color: colors.paperOn55,
  },
  doneRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  doneLine: { flex: 1, fontFamily: fonts.ui, fontSize: 13 },
  doneSender: { fontFamily: fonts.uiSemi, color: colors.paper },
  doneMeta: { color: colors.paperOn55 },
});
