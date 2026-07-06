// Zolva Agent under Profil (parity: classic Today's agent feed + Settings'
// trust section, re-homed per the Papir IA decision). Four sections:
// pending proposals (approve/dismiss), trust offers (accept/dismiss/revert),
// executed actions (revert where reversible), open loops (commitments).
//
// Every network action wraps in try/catch with per-row pending state — the
// classic cards' frozen-spinner class (main audit K5) must not reappear here.
import React, { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { Bot, Handshake, ListTodo } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { useEntitlement } from '../../lib/hooks';
import { presentPaywall } from '../../lib/paywall';
import {
  approveProposedAction,
  dismissProposedAction,
  useProposedActions,
  type ProposedActionRow,
} from '../../lib/agent-proposals';
import { revertAgentAction, useAgentActions, type AgentActionRow } from '../../lib/agent-feed';
import { useOpenCommitments } from '../../lib/agent-commitments';
import {
  decideTrustOffer,
  revertTrustOffer,
  useTrustOffers,
  type TrustOfferRow,
} from '../../lib/trust-offers';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';

const ACTION_LABELS: Record<string, string> = {
  'mail.send_reply': 'Sendte svar',
  'mail.draft_reply': 'Skrev udkast',
  'mail.send_new': 'Sendte mail',
  'mail.archive': 'Arkiverede',
  'mail.label': 'Sorterede',
  'mail.flag_important': 'Markerede vigtig',
  'mail.summarize': 'Opsummerede',
  'cal.create_event': 'Oprettede begivenhed',
  'cal.update_event': 'Opdaterede begivenhed',
};

function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? type;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <PaperText
      role="eyebrow"
      color={papirColor.ink3}
      style={{ paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl, paddingBottom: papirSpace.sm }}
    >
      {children}
    </PaperText>
  );
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clock(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function ProposalCard({ row }: { row: ProposedActionRow }) {
  const [pending, setPending] = useState<'send' | 'skip' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = str(row.preview.title) || 'Zolva foreslår';
  const body = str(row.preview.body);
  const isMail = row.action_type.startsWith('mail.');

  const run = async (kind: 'send' | 'skip') => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      const r = kind === 'send' ? await approveProposedAction(row.id) : await dismissProposedAction(row.id);
      if (!r.ok) setError('Kunne ikke gennemføres. Prøv igen.');
      // On success the realtime subscription removes the row.
    } catch {
      setError('Ingen forbindelse. Prøv igen.');
    } finally {
      setPending(null);
    }
  };

  return (
    <View
      style={{
        marginHorizontal: papirSpace.screen,
        marginBottom: 10,
        padding: 14,
        borderWidth: 1,
        borderColor: papirColor.line,
        borderRadius: papirRadius.xl,
        backgroundColor: papirColor.card,
      }}
    >
      <PaperText role="bodyStrong">{title}</PaperText>
      {body ? (
        <PaperText role="body" color={papirColor.ink2} numberOfLines={3} style={{ marginTop: 6 }}>
          {body}
        </PaperText>
      ) : null}
      {error ? (
        <PaperText role="small" color={papirColor.red} style={{ marginTop: 8 }}>
          {error}
        </PaperText>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        <ScaleButton
          scaleTo={0.96}
          haptic="light"
          onPress={() => void run('skip')}
          disabled={pending !== null}
          accessibilityRole="button"
          accessibilityLabel="Spring over"
          style={{
            paddingVertical: 9,
            paddingHorizontal: 16,
            borderRadius: papirRadius.pill,
            borderWidth: 1,
            borderColor: papirColor.line,
            minWidth: 96,
            alignItems: 'center',
          }}
        >
          {pending === 'skip' ? (
            <ActivityIndicator size="small" color={papirColor.ink} />
          ) : (
            <PaperText role="small">Spring over</PaperText>
          )}
        </ScaleButton>
        <ScaleButton
          scaleTo={0.96}
          haptic="light"
          onPress={() => void run('send')}
          disabled={pending !== null}
          accessibilityRole="button"
          accessibilityLabel={isMail ? 'Send' : 'Godkend'}
          style={{
            flex: 1,
            paddingVertical: 9,
            borderRadius: papirRadius.pill,
            backgroundColor: papirColor.ink,
            alignItems: 'center',
          }}
        >
          {pending === 'send' ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <PaperText role="small" color={papirColor.onInk}>
              {isMail ? 'Send' : 'Godkend'}
            </PaperText>
          )}
        </ScaleButton>
      </View>
    </View>
  );
}

function TrustCard({ row, userId }: { row: TrustOfferRow; userId: string }) {
  const [pending, setPending] = useState(false);
  const accepted = row.status === 'accepted';

  const decide = async (status: 'accepted' | 'dismissed') => {
    if (pending) return;
    setPending(true);
    try {
      const r = await decideTrustOffer(row.id, userId, status);
      if (!r.ok) Alert.alert('Tillid', 'Kunne ikke gemmes. Prøv igen.');
    } catch {
      Alert.alert('Tillid', 'Ingen forbindelse. Prøv igen.');
    } finally {
      setPending(false);
    }
  };

  const revert = async () => {
    if (pending) return;
    setPending(true);
    try {
      const r = await revertTrustOffer(row.id, userId);
      if (!r.ok) Alert.alert('Tillid', 'Kunne ikke fortrydes. Prøv igen.');
    } catch {
      Alert.alert('Tillid', 'Ingen forbindelse. Prøv igen.');
    } finally {
      setPending(false);
    }
  };

  return (
    <View
      style={{
        marginHorizontal: papirSpace.screen,
        marginBottom: 10,
        padding: 14,
        borderWidth: 1,
        borderColor: papirColor.line,
        borderRadius: papirRadius.xl,
        backgroundColor: papirColor.card,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Handshake size={16} color={papirColor.red} strokeWidth={1.8} />
        <PaperText role="bodyStrong" style={{ flex: 1 }}>
          {accepted ? `Sender selv til ${row.recipient}` : `Skal svar til ${row.recipient} sendes automatisk?`}
        </PaperText>
      </View>
      <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 4 }}>
        Du har godkendt {row.approval_count} svar til denne modtager.
      </PaperText>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
        {accepted ? (
          <Button label={pending ? '…' : 'Fortryd — spørg mig igen'} variant="ghost" onPress={() => void revert()} disabled={pending} />
        ) : (
          <>
            <Button label="Nej tak" variant="ghost" style={{ paddingHorizontal: 18 }} onPress={() => void decide('dismissed')} disabled={pending} />
            <Button label={pending ? '…' : 'Ja, send selv'} variant="primary" style={{ flex: 1 }} onPress={() => void decide('accepted')} disabled={pending} />
          </>
        )}
      </View>
    </View>
  );
}

function ExecutedRow({ row, divider }: { row: AgentActionRow; divider: boolean }) {
  const [pending, setPending] = useState(false);
  const reverted = !!row.reversed_at;
  const canRevert = row.reversible && !reverted;
  const detail = str(row.payload.subject) || str(row.payload.title) || str(row.payload.to);

  const revert = () => {
    Alert.alert('Fortryd handling?', `${actionLabel(row.action_type)}${detail ? ` — ${detail}` : ''}`, [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Fortryd',
        style: 'destructive',
        onPress: async () => {
          setPending(true);
          try {
            const r = await revertAgentAction(row.id);
            if (!r.ok) Alert.alert('Fortryd', 'Kunne ikke fortrydes. Prøv igen.');
          } catch {
            Alert.alert('Fortryd', 'Ingen forbindelse. Prøv igen.');
          } finally {
            setPending(false);
          }
        },
      },
    ]);
  };

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: papirSpace.screen }}>
        <View style={{ flex: 1 }}>
          <PaperText role="body">
            {actionLabel(row.action_type)}
            {detail ? (
              <PaperText role="body" color={papirColor.ink2}>
                {' '}· {detail}
              </PaperText>
            ) : null}
          </PaperText>
          <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }}>
            {clock(row.executed_at)}
            {reverted ? ' · fortrudt' : ''}
          </PaperText>
        </View>
        {canRevert ? (
          <ScaleButton
            scaleTo={0.95}
            haptic="light"
            onPress={revert}
            disabled={pending}
            accessibilityRole="button"
            accessibilityLabel="Fortryd handling"
            style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: papirRadius.pill, borderWidth: 1, borderColor: papirColor.line }}
          >
            {pending ? <ActivityIndicator size="small" color={papirColor.ink} /> : <PaperText role="small">Fortryd</PaperText>}
          </ScaleButton>
        ) : null}
      </View>
      {divider ? <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginHorizontal: papirSpace.screen }} /> : null}
    </View>
  );
}

export function PapirAgent() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const entitlement = useEntitlement();
  const proposals = useProposedActions(userId);
  const actions = useAgentActions(userId);
  const commitments = useOpenCommitments(userId);
  const trust = useTrustOffers(userId);

  const isPro = entitlement.data.tier === 'pro';
  const pendingProposals = proposals.rows.filter((r) => r.status === 'pending');
  const visibleTrust = trust.rows.filter((r) => r.status === 'pending' || r.status === 'accepted');
  const recentActions = [...actions.rows]
    .sort((a, b) => new Date(b.executed_at).getTime() - new Date(a.executed_at).getTime())
    .slice(0, 20);
  const openLoops = commitments.rows.filter((r) => r.status === 'open' || r.status === 'nudged');

  const loading = proposals.loading && actions.loading && trust.loading;
  const empty =
    pendingProposals.length === 0 && visibleTrust.length === 0 && recentActions.length === 0 && openLoops.length === 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Zolva Agent" />

      {!isPro ? (
        <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.screen, gap: 10 }}>
          <Bot size={28} color={papirColor.ink3} strokeWidth={1.5} />
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Agenten er en Pro-funktion
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Med Pro arbejder Zolva selv: foreslår svar, holder styr på løse ender og handler med din tilladelse.
          </PaperText>
          <Button label="Se Premium" variant="primary" style={{ paddingHorizontal: 28, marginTop: 6 }} onPress={() => void presentPaywall()} />
        </View>
      ) : loading && empty ? (
        <View style={{ alignItems: 'center', paddingTop: 60 }}>
          <PapirLoader />
        </View>
      ) : empty ? (
        <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <Bot size={28} color={papirColor.ink3} strokeWidth={1.5} />
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Alt er roligt
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Når Zolva foreslår noget eller handler for dig, lander det her.
          </PaperText>
        </View>
      ) : (
        <>
          {pendingProposals.length > 0 ? (
            <>
              <SectionLabel>Venter på dig</SectionLabel>
              {pendingProposals.map((r) => (
                <ProposalCard key={r.id} row={r} />
              ))}
            </>
          ) : null}

          {visibleTrust.length > 0 && userId ? (
            <>
              <SectionLabel>Tillid</SectionLabel>
              {visibleTrust.map((r) => (
                <TrustCard key={r.id} row={r} userId={userId} />
              ))}
            </>
          ) : null}

          {openLoops.length > 0 ? (
            <>
              <SectionLabel>Åbne løkker</SectionLabel>
              {openLoops.map((r, i) => (
                <View key={r.id}>
                  <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 11, paddingHorizontal: papirSpace.screen }}>
                    <ListTodo size={15} color={papirColor.red} strokeWidth={1.8} style={{ marginTop: 3 }} />
                    <View style={{ flex: 1 }}>
                      <PaperText role="body">{r.summary}</PaperText>
                      <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 2 }}>
                        {r.counterparty}
                        {r.due_at ? ` · ${clock(r.due_at)}` : ''}
                      </PaperText>
                    </View>
                  </View>
                  {i < openLoops.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginHorizontal: papirSpace.screen }} />
                  ) : null}
                </View>
              ))}
            </>
          ) : null}

          {recentActions.length > 0 ? (
            <>
              <SectionLabel>Udført</SectionLabel>
              {recentActions.map((r, i) => (
                <ExecutedRow key={r.id} row={r} divider={i < recentActions.length - 1} />
              ))}
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
