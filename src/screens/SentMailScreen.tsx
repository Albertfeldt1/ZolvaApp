// src/screens/SentMailScreen.tsx
//
// Slide-up overlay launched from the Inbox top-bar paperplane button.
// Lists every mail Zolva has sent on the current user's behalf, across
// all providers (Gmail, Outlook, iCloud). Primary value: confirmable
// record for iCloud sends — those don't land in Apple Mail's Sent folder
// (see 2026-05-06-icloud-send-mail-design.md non-goals).

import { ChevronLeft, Trash2 } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { useAuth } from '../lib/auth';
import {
  clearSentMails,
  listSentMails,
  subscribeSentMails,
  type SentMailRecord,
} from '../lib/sent-mails';

type Props = { onClose: () => void };

export function SentMailScreen({ onClose }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const [records, setRecords] = useState<SentMailRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) { setRecords([]); return; }
    setRecords(await listSentMails(userId));
  }, [userId]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const unsub = subscribeSentMails((id) => { if (id === userId) reload(); });
    return unsub;
  }, [userId, reload]);

  const groups = useMemo(() => groupByDay(records), [records]);
  const hasAny = records.length > 0;

  const handleClear = useCallback(() => {
    Alert.alert(
      'Ryd sendte mails?',
      'Listen i Zolva slettes — selve mailene er ikke påvirket.',
      [
        { text: 'Annullér', style: 'cancel' },
        { text: 'Ryd', style: 'destructive', onPress: () => { void clearSentMails(userId); } },
      ],
    );
  }, [userId]);

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />

      <View
        style={{
          paddingTop: Platform.OS === 'ios' ? 58 : 40,
          paddingBottom: spacing.md,
          paddingHorizontal: spacing.screenPad,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <GlassFrostedCard
          radius={radius.card}
          style={{
            paddingVertical: spacing.md,
            paddingHorizontal: spacing.cardPad,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
          }}
        >
          <Pressable
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Tilbage"
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              borderRadius: radius.pill,
              backgroundColor: surface.iconButton,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <ChevronLeft size={18} color={t.ink2} strokeWidth={1.75} />
          </Pressable>

          <View style={{ flex: 1 }}>
            <Text style={{ ...type.eyebrow, color: t.ink3 }}>SENDT FRA ZOLVA</Text>
          </View>

          <Pressable
            onPress={handleClear}
            disabled={!hasAny}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Ryd sendte mails"
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              borderRadius: radius.pill,
              backgroundColor: hasAny ? surface.iconButton : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !hasAny ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Trash2 size={16} color={t.ink2} strokeWidth={1.75} />
          </Pressable>
        </GlassFrostedCard>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
      >
        {!hasAny ? (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.lg }}>
            <GlassFrostedCard
              overlay={surface.bone}
              style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.lg }}
            >
              <Stone size={56} jumpOnTap={false} />
              <Text
                style={{
                  fontFamily: fonts.display,
                  fontSize: 20,
                  letterSpacing: -0.4,
                  color: t.ink,
                  textAlign: 'center',
                }}
              >
                Ingen sendte mails endnu
              </Text>
              <Text style={{ ...type.body, color: t.ink3, textAlign: 'center' }}>
                Når jeg sender en mail for dig, dukker den op her — så du altid kan se hvad der er sendt.
              </Text>
            </GlassFrostedCard>
          </View>
        ) : (
          groups.map((group) => (
            <View
              key={group.key}
              style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  paddingHorizontal: spacing.xs,
                  paddingBottom: spacing.sm,
                }}
              >
                <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600' }}>
                  {group.label}
                </Text>
                <Text style={{ ...type.eyebrow, color: t.ink3 }}>{group.records.length}</Text>
              </View>

              <GlassFrostedCard style={{ overflow: 'hidden' }}>
                {group.records.map((rec, idx) => (
                  <SentRow
                    key={rec.id}
                    record={rec}
                    expanded={expandedId === rec.id}
                    onToggle={() =>
                      setExpandedId((cur) => (cur === rec.id ? null : rec.id))
                    }
                    showDivider={idx < group.records.length - 1}
                  />
                ))}
              </GlassFrostedCard>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

type RowProps = {
  record: SentMailRecord;
  expanded: boolean;
  onToggle: () => void;
  showDivider: boolean;
};

function SentRow({ record, expanded, onToggle, showDivider }: RowProps) {
  const { t, type, fonts, spacing } = useTheme();
  const time = new Date(record.sentAt);
  const timeLabel = time.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  const providerLabel =
    record.provider === 'google' ? 'Gmail' :
    record.provider === 'microsoft' ? 'Outlook' : 'iCloud';
  const recipients = record.to.join(', ') || '—';

  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => ({
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.cardPad,
        borderBottomWidth: showDivider ? 1 : 0,
        borderBottomColor: t.ink3 + '22',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text
          style={{ fontFamily: fonts.uiBold, fontSize: 14, color: t.ink, flex: 1, marginRight: spacing.md }}
          numberOfLines={1}
        >
          {record.subject || '(uden emne)'}
        </Text>
        <Text style={{ ...type.eyebrow, color: t.ink3 }}>{timeLabel}</Text>
      </View>
      <Text style={{ ...type.body, color: t.ink2, marginTop: 2 }} numberOfLines={1}>
        Til: {recipients}
      </Text>
      <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: 4 }}>
        {providerLabel}{record.replyToId ? ' · svar' : ''}
      </Text>
      {expanded ? (
        <View style={{ marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: t.ink3 + '22' }}>
          {record.cc && record.cc.length > 0 ? (
            <Text style={{ ...type.body, color: t.ink2 }}>Cc: {record.cc.join(', ')}</Text>
          ) : null}
          <Text style={{ ...type.body, color: t.ink, marginTop: spacing.sm, lineHeight: 20 }}>
            {record.body}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

type Group = { key: string; label: string; records: SentMailRecord[] };

function groupByDay(records: SentMailRecord[]): Group[] {
  if (records.length === 0) return [];
  const byKey = new Map<string, SentMailRecord[]>();
  for (const r of records) {
    const d = new Date(r.sentAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;

  const groups: Group[] = [];
  for (const [key, list] of byKey.entries()) {
    const sample = new Date(list[0].sentAt);
    const label =
      key === todayKey ? 'I dag' :
      key === yesterdayKey ? 'I går' :
      sample.toLocaleDateString('da-DK', { day: 'numeric', month: 'long' });
    groups.push({ key, label, records: list });
  }
  groups.sort((a, b) => (a.records[0].sentAt < b.records[0].sentAt ? 1 : -1));
  return groups;
}
