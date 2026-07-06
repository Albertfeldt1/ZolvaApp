// Notifikationsfeed under Profil (parity: classic NotificationsScreen,
// re-homed per the Papir IA decision — Home is frozen, so no bell there).
// Rows route to their PAPIR destination: brief → briefing, newMail → inbox,
// chatReply → chat, factDecay → Historik/Fakta, agent_proposal → agent,
// reminder/digest/calendarPreAlert → Plan.
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import {
  Bell,
  Bot,
  Calendar,
  CheckCheck,
  Mail,
  MessageSquare,
  Sparkles,
  Sun,
  type LucideIcon,
} from 'lucide-react-native';
import { IconButton, PaperText, papirColor, papirSpace } from '../../design/papir';
import { useNotificationFeed } from '../../lib/hooks';
import type { FeedEntry, FeedEntryType } from '../../lib/types';
import { usePapirNav, type PushScreen } from './nav';
import { requestHistorySegment } from './PapirHistory';
import { PushHeader } from './PushHeader';
import { useNow } from './useNow';

const TYPE_ICONS: Partial<Record<FeedEntryType, LucideIcon>> = {
  reminder: Bell,
  reminderAdded: Bell,
  digest: Sun,
  brief: Sun,
  calendarPreAlert: Calendar,
  newMail: Mail,
  chatReply: MessageSquare,
  factDecay: Sparkles,
  agent_proposal: Bot,
  trialEnding: Sparkles,
};

/** Where a tapped entry goes in Papir. Returns null for tab-only targets. */
function destinationFor(type: FeedEntryType): { push?: PushScreen; tab?: 'plan' | 'history' } | null {
  switch (type) {
    case 'brief':
      return { push: 'briefing' };
    case 'newMail':
      return { push: 'inbox' };
    case 'chatReply':
      return { push: 'chat' };
    case 'agent_proposal':
      return { push: 'agent' };
    case 'factDecay':
      return { tab: 'history' };
    case 'reminder':
    case 'reminderAdded':
    case 'digest':
    case 'calendarPreAlert':
      return { tab: 'plan' };
    default:
      return null;
  }
}

function dayLabel(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return 'I dag';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'I går';
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PapirNotifications() {
  const nav = usePapirNav();
  const feed = useNotificationFeed();
  const now = useNow();

  const unread = feed.data.filter((e) => !e.readAt).length;

  // Group by day, newest first (the hook already sorts by firesAt desc).
  const groups: { label: string; items: FeedEntry[] }[] = [];
  feed.data.forEach((e) => {
    const label = dayLabel(e.firesAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  });

  const open = (e: FeedEntry) => {
    feed.markRead(e.id);
    const dest = destinationFor(e.type);
    if (!dest) return;
    if (dest.tab === 'history') {
      requestHistorySegment(2); // Fakta
      nav.setTab('history');
      return;
    }
    if (dest.tab) {
      nav.setTab(dest.tab);
      return;
    }
    if (dest.push) nav.push(dest.push);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader
        title="Notifikationer"
        right={
          unread > 0 ? (
            <IconButton accessibilityLabel="Markér alle som læst" onPress={feed.markAll}>
              <CheckCheck size={16} color={papirColor.ink2} strokeWidth={1.8} />
            </IconButton>
          ) : undefined
        }
      />

      {feed.data.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <Bell size={26} color={papirColor.ink3} strokeWidth={1.5} />
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Ingen notifikationer
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Påmindelser, briefinger og nyt fra agenten samles her.
          </PaperText>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.label}>
            <PaperText
              role="eyebrow"
              color={papirColor.ink3}
              style={{ paddingHorizontal: papirSpace.screen, paddingTop: papirSpace.xl, paddingBottom: papirSpace.sm }}
            >
              {g.label}
            </PaperText>
            {g.items.map((e, i) => {
              const Icon = TYPE_ICONS[e.type] ?? Bell;
              const isUnread = !e.readAt;
              return (
                <View key={e.id}>
                  <Pressable
                    onPress={() => open(e)}
                    accessibilityRole="button"
                    accessibilityLabel={e.title}
                    style={{ flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: papirSpace.screen }}
                  >
                    <View style={{ marginTop: 2 }}>
                      <Icon size={17} color={isUnread ? papirColor.red : papirColor.ink3} strokeWidth={1.8} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {isUnread ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: papirColor.red }} /> : null}
                        <PaperText role={isUnread ? 'bodyStrong' : 'body'} style={{ flex: 1 }} numberOfLines={1}>
                          {e.title}
                        </PaperText>
                        <PaperText role="caption" color={papirColor.ink4} tabular>
                          {clock(e.firesAt)}
                        </PaperText>
                      </View>
                      {e.body ? (
                        <PaperText role="caption" color={papirColor.ink3} numberOfLines={2} style={{ marginTop: 2 }}>
                          {e.body}
                        </PaperText>
                      ) : null}
                    </View>
                  </Pressable>
                  {i < g.items.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginHorizontal: papirSpace.screen }} />
                  ) : null}
                </View>
              );
            })}
          </View>
        ))
      )}
    </ScrollView>
  );
}
