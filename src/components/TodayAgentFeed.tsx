import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAgentActions } from '../lib/agent-feed';
import { useProposedActions } from '../lib/agent-proposals';
import { useTrustOffers } from '../lib/trust-offers';
import { useAuth } from '../lib/auth';
import { AgentActionCard } from './AgentActionCard';
import { ProposedActionCard } from './ProposedActionCard';
import { TrustOfferCard } from './TrustOfferCard';
import { AgentEmptyState } from './AgentEmptyState';
import { colors } from '../theme';

export function TodayAgentFeed() {
  const { user } = useAuth();
  const { rows: actions, loading: actionsLoading } = useAgentActions(user?.id);
  const { rows: proposals, loading: proposalsLoading } = useProposedActions(user?.id);
  const { rows: trustOffers, loading: offersLoading } = useTrustOffers(user?.id);

  const pending = proposals.filter((p) => p.status === 'pending');
  const pendingOffers = trustOffers.filter((o) => o.status === 'pending');
  const visibleActions = actions.filter((r) => !r.reversed_at);
  const loading = actionsLoading || proposalsLoading || offersLoading;

  if (
    loading ||
    (pendingOffers.length === 0 && pending.length === 0 && visibleActions.length === 0)
  ) {
    return <AgentEmptyState />;
  }
  return (
    <View>
      <Text style={styles.header}>
        {pending.length} venter · {visibleActions.length} udført
      </Text>
      {pendingOffers.map((o) => (
        <TrustOfferCard key={o.id} row={o} />
      ))}
      {pending.map((p) => (
        <ProposedActionCard key={p.id} row={p} />
      ))}
      {visibleActions.map((r) => (
        <AgentActionCard key={r.id} row={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    color: colors.fg3,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
});
