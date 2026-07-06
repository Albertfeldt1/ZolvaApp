import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { AlertTriangle, Star } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { refreshMailNow, useHasProvider, useInboxWaiting, useMicrosoftLinked } from '../../lib/hooks';
import type { InboxMail, MailProvider } from '../../lib/types';
import { usePapirNav } from './nav';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

// Provider avatar duos from the approved design: a single letter on the
// provider's soft accent — Gmail rust, Outlook slate, iCloud neutral.
const PROVIDER_AVATAR: Record<MailProvider, { letter: string; bg: string; color: string }> = {
  google: { letter: 'G', bg: papirColor.rustSoft, color: papirColor.rust },
  microsoft: { letter: 'O', bg: papirColor.slateSoft, color: papirColor.slate },
  icloud: { letter: 'i', bg: papirColor.paper2, color: papirColor.ink2 },
};

/** Auth-class errors need re-connect; everything else is transient. */
function errorLine(provider: string, code: string): string {
  const name = PROVIDER_NAMES[provider] ?? provider;
  if (code.includes('auth') || code.includes('reauth') || code.includes('credential')) {
    return `${name}-forbindelsen er udløbet. Genopret den under Indstillinger i den klassiske visning.`;
  }
  return `${name} kunne ikke hentes lige nu. Træk ned for at prøve igen.`;
}

/** Mail row per the approved design: provider-letter avatar, sender + time,
 * subject, snippet line, and a starred "Svar klar" badge when the AI draft
 * is ready. Lives inside the white list card. */
function MailRow({ mail, onPress }: { mail: InboxMail; onPress: () => void }) {
  const avatar = PROVIDER_AVATAR[mail.provider];
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="none"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${mail.from}: ${mail.subject}`}
      style={{
        flexDirection: 'row',
        gap: 13,
        alignItems: 'flex-start',
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 999,
          backgroundColor: avatar.bg,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        <PaperText role="bodyStrong" color={avatar.color} style={{ fontSize: 14 }}>
          {avatar.letter}
        </PaperText>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <PaperText role="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
            {mail.from}
          </PaperText>
          <PaperText role="caption" color={papirColor.ink4} tabular>
            {mail.time}
          </PaperText>
        </View>
        <PaperText role="body" style={{ marginTop: 2 }} numberOfLines={1}>
          {mail.subject}
        </PaperText>
        {mail.preview ? (
          <PaperText role="small" color={papirColor.ink3} style={{ marginTop: 2, fontWeight: undefined }} numberOfLines={1}>
            {mail.preview}
          </PaperText>
        ) : null}
        {mail.aiDraft ? (
          <View
            style={{
              alignSelf: 'flex-start',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              marginTop: 7,
              backgroundColor: papirColor.greenSoft,
              borderRadius: 999,
              paddingVertical: 3,
              paddingHorizontal: 9,
            }}
          >
            <Star size={10} color={papirColor.green} fill={papirColor.green} />
            <PaperText role="caption" color={papirColor.green} style={{ fontSize: 11.5 }}>
              Svar klar
            </PaperText>
          </View>
        ) : null}
      </View>
    </ScaleButton>
  );
}

type TierChip = { key: string; label: string; mails: InboxMail[]; showCount: boolean };

/** Segment chips per the approved design: one tier visible at a time, counts
 * only where the number is a call to action (Haster / Venter på dig). */
function ChipRow({ chips, active, onSelect }: { chips: TierChip[]; active: string; onSelect: (k: string) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: papirSpace.screen, paddingBottom: papirSpace.base }}
    >
      {chips.map((c) => {
        const on = c.key === active;
        return (
          <ScaleButton
            key={c.key}
            scaleTo={0.96}
            haptic="selection"
            onPress={() => onSelect(c.key)}
            accessibilityRole="button"
            accessibilityLabel={c.label}
            style={{
              paddingVertical: 9,
              paddingHorizontal: 16,
              borderRadius: papirRadius.pill,
              backgroundColor: on ? papirColor.ink : papirColor.card,
              borderWidth: 1,
              borderColor: on ? papirColor.ink : papirColor.line,
            }}
          >
            <PaperText role="small" color={on ? papirColor.onInk : papirColor.ink2}>
              {c.showCount && c.mails.length > 0 ? `${c.label} · ${c.mails.length}` : c.label}
            </PaperText>
          </ScaleButton>
        );
      })}
    </ScrollView>
  );
}

export function PapirInbox() {
  const nav = usePapirNav();
  const inbox = useInboxWaiting();
  const hasProvider = useHasProvider();
  const [refreshing, setRefreshing] = useState(false);

  // Provider-linked-but-no-token (same detection as classic InboxScreen):
  // the silent refresh 404'ed because the stored grant is gone, so the
  // provider's mails are silently absent until the user re-authenticates.
  // Without this banner there is no recovery path in Papir at all.
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
  const providers = (user?.app_metadata?.providers as string[] | undefined) ?? [];
  // useMicrosoftLinked instead of providers.includes('azure'): new-flow
  // Microsoft users bypass gotrue and won't appear in app_metadata.providers.
  const microsoftLinked = useMicrosoftLinked(user?.id ?? null);
  const reauths: { provider: string; name: string; onPress: () => void }[] = [];
  if (!initializing && !microsoftRefreshingAtBoot && microsoftLinked && !microsoftAccessToken) {
    reauths.push({ provider: 'microsoft', name: 'Outlook', onPress: () => void signInWithMicrosoft() });
  }
  if (!initializing && !googleRefreshingAtBoot && providers.includes('google') && !googleAccessToken) {
    reauths.push({ provider: 'google', name: 'Gmail', onPress: () => void signInWithGoogle() });
  }

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refreshMailNow();
    // The refresh signal is fire-and-forget; hold the spinner briefly so the
    // gesture reads as acknowledged, then let the list update as data lands.
    setTimeout(() => setRefreshing(false), 900);
  }, []);

  const tiers = useMemo(() => {
    const t: Record<0 | 1 | 2 | 3, InboxMail[]> = { 0: [], 1: [], 2: [], 3: [] };
    inbox.data.forEach((m) => t[m.tier].push(m));
    return t;
  }, [inbox.data]);

  const chips: TierChip[] = useMemo(
    () => [
      { key: 'haster', label: 'Haster', mails: tiers[0], showCount: true },
      { key: 'venter', label: 'Venter på dig', mails: tiers[1], showCount: true },
      { key: 'nyhedsbreve', label: 'Nyhedsbreve', mails: tiers[2], showCount: false },
      { key: 'notifikationer', label: 'Notifikationer', mails: tiers[3], showCount: false },
      { key: 'laest', label: 'Læst', mails: inbox.read, showCount: false },
    ],
    [tiers, inbox.read],
  );

  // Until the user picks a chip, land on the first tier with content — an
  // empty "Haster" as the fixed default would read as a broken inbox.
  const [pickedChip, setPickedChip] = useState<string | null>(null);
  const activeChip = pickedChip ?? chips.find((c) => c.mails.length > 0)?.key ?? 'venter';
  const activeMails = chips.find((c) => c.key === activeChip)?.mails ?? [];

  const openMail = (m: InboxMail) =>
    nav.push('mailDetail', {
      id: m.id,
      provider: m.provider,
      from: m.from,
      subject: m.subject,
      time: m.time,
      aiDraft: m.aiDraft,
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={papirColor.red} />}
    >
      <PushHeader title="Indbakke" />

      {reauths.map(({ provider, name, onPress }) => (
        <View
          key={`reauth:${provider}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginHorizontal: papirSpace.screen,
            marginBottom: 10,
            padding: 12,
            borderRadius: papirRadius.md,
            backgroundColor: papirColor.redSoft,
          }}
        >
          <AlertTriangle size={16} color={papirColor.red} strokeWidth={1.8} />
          <PaperText role="small" color={papirColor.ink2} style={{ flex: 1 }}>
            {name} mistede forbindelsen — dine {name}-mails vises ikke.
          </PaperText>
          <ScaleButton
            scaleTo={0.97}
            haptic="light"
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Forbind ${name} igen`}
            style={{ paddingVertical: 4, paddingLeft: 6 }}
          >
            <PaperText role="bodyStrong" color={papirColor.red}>
              Forbind igen
            </PaperText>
          </ScaleButton>
        </View>
      ))}

      {/* Provider errors: expired tokens / transient failures (K5). Without
          this an expired Gmail login looks like an empty, healthy inbox.
          Skip providers already covered by a re-auth banner above. */}
      {inbox.providerErrors.filter((e) => !reauths.some((r) => r.provider === e.provider)).map((e) => (
        <View
          key={e.provider}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginHorizontal: papirSpace.screen,
            marginBottom: 10,
            padding: 12,
            borderRadius: papirRadius.md,
            backgroundColor: papirColor.redSoft,
          }}
        >
          <AlertTriangle size={16} color={papirColor.red} strokeWidth={1.8} />
          <PaperText role="small" color={papirColor.ink2} style={{ flex: 1 }}>
            {errorLine(e.provider, e.code)}
          </PaperText>
        </View>
      ))}

      {inbox.loading && inbox.data.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 60 }}>
          <PapirLoader />
        </View>
      ) : !hasProvider ? (
        <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Ingen mail forbundet
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
            Forbind Gmail, Outlook eller iCloud i Indstillinger for at se din indbakke.
          </PaperText>
        </View>
      ) : inbox.data.length === 0 && inbox.read.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Alt er klaret
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
            Ingen mails venter på dig lige nu.
          </PaperText>
        </View>
      ) : (
        <>
          <ChipRow chips={chips} active={activeChip} onSelect={setPickedChip} />
          {activeMails.length === 0 ? (
            <PaperText
              role="body"
              color={papirColor.ink3}
              style={{ paddingHorizontal: papirSpace.screen, paddingTop: 40, textAlign: 'center' }}
            >
              Ingen mails her.
            </PaperText>
          ) : (
            <View
              style={{
                marginHorizontal: papirSpace.screen,
                backgroundColor: papirColor.card,
                borderWidth: 1,
                borderColor: papirColor.line,
                borderRadius: papirRadius.xl,
                overflow: 'hidden',
              }}
            >
              {activeMails.map((m, i) => (
                <View key={`${m.provider}:${m.id}`}>
                  <MailRow mail={m} onPress={() => openMail(m)} />
                  {i < activeMails.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginLeft: 67 }} />
                  ) : null}
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
