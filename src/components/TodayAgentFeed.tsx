import React from 'react';
import { View } from 'react-native';
import { useAgentActions } from '../lib/agent-feed';
import { useAuth } from '../lib/auth';
import { AgentActionCard } from './AgentActionCard';
import { AgentEmptyState } from './AgentEmptyState';

export function TodayAgentFeed() {
  const { user } = useAuth();
  const { rows, loading } = useAgentActions(user?.id);
  const visible = rows.filter((r) => !r.reversed_at);
  if (loading || visible.length === 0) return <AgentEmptyState />;
  return (
    <View>
      {visible.map((r) => (
        <AgentActionCard key={r.id} row={r} />
      ))}
    </View>
  );
}
