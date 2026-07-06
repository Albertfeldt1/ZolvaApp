import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { AlertTriangle, ChevronDown } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { refreshMailNow, useHasProvider, useInboxWaiting } from '../../lib/hooks';
import type { InboxMail } from '../../lib/types';
import { usePapirNav } from './nav';
import { PushHeader } from './PushHeader';

const PROVIDER_NAMES: Record<string, string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

/** Auth-class errors need re-connect; everything else is transient. */
function errorLine(provider: string, code: string): string {
  const name = PROVIDER_NAMES[provider] ?? provider;
  if (code.includes('auth') || code.includes('reauth') || code.includes('credential')) {
    return `${name}-forbindelsen er udløbet. Genopret den under Indstillinger i den klassiske visning.`;
  }
  return `${name} kunne ikke hentes lige nu. Træk ned for at prøve igen.`;
}

function MailRow({ mail, onPress }: { mail: InboxMail; onPress: () => void }) {
  const urgent = mail.tier === 0;
  return (
    <ScaleButton
      scaleTo={0.99}
      haptic="none"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${mail.from}: ${mail.subject}`}
      style={{
        flexDirection: 'row',
        gap: 14,
        alignItems: 'flex-start',
        paddingHorizontal: papirSpace.screen,
        paddingVertical: 14,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: papirRadius.sm + 2,
          backgroundColor: papirColor.paper2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PaperText role="bodyStrong" color={papirColor.ink2}>
          {mail.initials}
        </PaperText>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {urgent ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: papirColor.red }} /> : null}
          <PaperText role="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
            {mail.from}
          </PaperText>
          <PaperText role="caption" color={papirColor.ink4}>
            {mail.time}
          </PaperText>
        </View>
        <PaperText role="body" style={{ marginTop: 2 }} numberOfLines={1}>
          {mail.subject}
        </PaperText>
        {mail.aiDraft ? (
          <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }} numberOfLines={1}>
            Udkast klar: {mail.aiDraft}
          </PaperText>
        ) : null}
      </View>
    </ScaleButton>
  );
}

function Section({
  label,
  mails,
  collapsible,
  onOpen,
}: {
  label: string;
  mails: InboxMail[];
  collapsible?: boolean;
  onOpen: (m: InboxMail) => void;
}) {
  const [open, setOpen] = useState(!collapsible);
  if (mails.length === 0) return null;
  return (
    <View>
      <ScaleButton
        scaleTo={0.99}
        haptic={collapsible ? 'light' : 'none'}
        onPress={collapsible ? () => setOpen((o) => !o) : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: papirSpace.screen,
          paddingTop: papirSpace.xl,
          paddingBottom: papirSpace.sm,
        }}
      >
        <PaperText role="eyebrow" color={papirColor.ink3} style={{ flex: 1 }}>
          {label} · {mails.length}
        </PaperText>
        {collapsible ? (
          <ChevronDown
            size={15}
            color={papirColor.ink3}
            strokeWidth={2}
            style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
          />
        ) : null}
      </ScaleButton>
      {open
        ? mails.map((m, i) => (
            <View key={`${m.provider}:${m.id}`}>
              <MailRow mail={m} onPress={() => onOpen(m)} />
              {i < mails.length - 1 ? (
                <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

export function PapirInbox() {
  const nav = usePapirNav();
  const inbox = useInboxWaiting();
  const hasProvider = useHasProvider();
  const [refreshing, setRefreshing] = useState(false);

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

  const needsReply = tiers[0].length + tiers[1].length;

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

      {/* Provider errors: expired tokens / transient failures (K5). Without
          this an expired Gmail login looks like an empty, healthy inbox. */}
      {inbox.providerErrors.map((e) => (
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
          <ActivityIndicator color={papirColor.red} />
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
          {needsReply > 0 ? (
            <PaperText role="eyebrow" color={papirColor.red} style={{ paddingHorizontal: papirSpace.screen, paddingBottom: 8 }}>
              {needsReply} kræver svar
            </PaperText>
          ) : null}
          <Section label="Haster" mails={tiers[0]} onOpen={openMail} />
          <Section label="Venter på dig" mails={tiers[1]} onOpen={openMail} />
          <Section label="Nyhedsbreve" mails={tiers[2]} collapsible onOpen={openMail} />
          <Section label="Notifikationer" mails={tiers[3]} collapsible onOpen={openMail} />
          <Section label="Læst" mails={inbox.read} collapsible onOpen={openMail} />
        </>
      )}
    </ScrollView>
  );
}
