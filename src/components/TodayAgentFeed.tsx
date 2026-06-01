import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, View, Text, StyleSheet } from 'react-native';
import { useAgentActions } from '../lib/agent-feed';
import { useProposedActions, type ProposedActionRow } from '../lib/agent-proposals';
import { useTrustOffers } from '../lib/trust-offers';
import { useAuth } from '../lib/auth';
import { AgentActionCard } from './AgentActionCard';
import { ProposedActionCard } from './ProposedActionCard';
import { TrustOfferCard } from './TrustOfferCard';
import { AgentEmptyState } from './AgentEmptyState';
import { colors } from '../theme';

type Props = {
  /**
   * Called when the user taps a proposal card's body/title area to open
   * the full detail modal. The parent (TodayScreen) holds the selected-row
   * state and mounts ProposalDetailModal **outside the ScrollView** so the
   * Animated.View overlay is never clipped by the scroll container.
   */
  onSelectProposal: (row: ProposedActionRow) => void;
  /**
   * Reports whether the feed currently has nothing to show (loading or no
   * pending offers/proposals and no visible executed actions). TodayScreen
   * uses this to drive the unified quiet-state card layout.
   */
  onEmpty?: (empty: boolean) => void;
  /**
   * When true, the feed renders flush inside a parent card: the empty state is
   * inline and the interactive cards drop their own surface/shadow/margins.
   */
  embedded?: boolean;
};

export function TodayAgentFeed({ onSelectProposal, onEmpty, embedded = false }: Props) {
  const { user } = useAuth();
  const { rows: actions, loading: actionsLoading } = useAgentActions(user?.id);
  const { rows: proposals, loading: proposalsLoading } = useProposedActions(user?.id);
  const { rows: trustOffers, loading: offersLoading } = useTrustOffers(user?.id);

  // "Ryd alle" hides the carried-out actions by stashing a per-user
  // cleared-before timestamp locally. It only hides the executed log from this
  // device's feed — it doesn't undo actions or delete the server-side history.
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    void AsyncStorage.getItem(clearKey(user.id)).then((v) => setClearedAt(v));
  }, [user?.id]);

  const pending = proposals.filter((p) => p.status === 'pending');
  const pendingOffers = trustOffers.filter((o) => o.status === 'pending');
  const visibleActions = actions.filter(
    (r) =>
      !r.reversed_at &&
      (!clearedAt || !r.executed_at || new Date(r.executed_at).getTime() > new Date(clearedAt).getTime()),
  );
  const loading = actionsLoading || proposalsLoading || offersLoading;

  const clearAll = () => {
    if (!user?.id || visibleActions.length === 0) return;
    Alert.alert('Ryd udførte handlinger?', 'Listen ryddes på denne enhed. Det kan ikke fortrydes.', [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Ryd alle',
        style: 'destructive',
        onPress: () => {
          const now = new Date().toISOString();
          void AsyncStorage.setItem(clearKey(user.id), now);
          setClearedAt(now);
        },
      },
    ]);
  };

  const isEmpty =
    loading ||
    (pendingOffers.length === 0 && pending.length === 0 && visibleActions.length === 0);

  useEffect(() => {
    onEmpty?.(isEmpty);
  }, [isEmpty]);

  if (isEmpty) {
    return <AgentEmptyState embedded={embedded} />;
  }
  return (
    <View>
      <Text style={[styles.header, embedded && styles.embeddedRow]}>
        {pending.length} venter · {visibleActions.length} udført
      </Text>
      {pendingOffers.map((o) => (
        <TrustOfferCard key={o.id} row={o} embedded={embedded} />
      ))}
      {pending.map((p) => (
        <ProposedActionCard
          key={p.id}
          row={p}
          onOpenDetail={() => onSelectProposal(p)}
          embedded={embedded}
        />
      ))}
      {visibleActions.length > 0 && (
        <View style={[styles.clearRow, embedded && styles.embeddedRow]}>
          <Text style={styles.clearLabel}>Udført af Zolva</Text>
          <Pressable onPress={clearAll} hitSlop={8} accessibilityRole="button" accessibilityLabel="Ryd alle">
            <Text style={styles.clearBtn}>Ryd alle</Text>
          </Pressable>
        </View>
      )}
      {visibleActions.map((r) => (
        <AgentActionCard key={r.id} row={r} embedded={embedded} />
      ))}
    </View>
  );
}

const clearKey = (userId: string) => `zolva.agentfeed.clearedAt.${userId}`;

const styles = StyleSheet.create({
  header: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  clearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 4,
  },
  clearLabel: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  clearBtn: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  // Flush horizontal alignment when the feed lives inside the unified card,
  // which already supplies its own horizontal padding.
  embeddedRow: { paddingHorizontal: 0 },
});
