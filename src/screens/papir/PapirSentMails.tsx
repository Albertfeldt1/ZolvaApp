// Sendte mails under Profil (parity: classic SentMailScreen). Lister alle
// mails Zolva har sendt på brugerens vegne på tværs af Gmail/Outlook/iCloud.
// Primær værdi: bekræftelse for iCloud-sends, som ikke lander i Apple Mails
// Sendt-mappe. Datalag deles 1:1 med klassisk (src/lib/sent-mails.ts).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { Send, Trash2 } from 'lucide-react-native';
import { IconButton, PaperText, papirColor, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import {
  clearSentMails,
  listSentMails,
  subscribeSentMails,
  type SentMailRecord,
} from '../../lib/sent-mails';
import { PushHeader } from './PushHeader';
import { useNow } from './useNow';

const PROVIDER_LABEL: Record<SentMailRecord['provider'], string> = {
  google: 'Gmail',
  microsoft: 'Outlook',
  icloud: 'iCloud',
};

function dayLabel(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return 'I dag';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'I går';
  return d.toLocaleDateString('da-DK', { day: 'numeric', month: 'long' });
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PapirSentMails() {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  const now = useNow();
  const [records, setRecords] = useState<SentMailRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) {
      setRecords([]);
      return;
    }
    setRecords(await listSentMails(userId));
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    return subscribeSentMails((id) => {
      if (id === userId) void reload();
    });
  }, [userId, reload]);

  const groups = useMemo(() => {
    const out: { label: string; items: SentMailRecord[] }[] = [];
    records.forEach((r) => {
      const label = dayLabel(new Date(r.sentAt), now);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(r);
      else out.push({ label, items: [r] });
    });
    return out;
  }, [records, now]);

  const handleClear = useCallback(() => {
    Alert.alert('Ryd sendte mails?', 'Listen i Zolva slettes — selve mailene er ikke påvirket.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Ryd', style: 'destructive', onPress: () => void clearSentMails(userId) },
    ]);
  }, [userId]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader
        title="Sendte mails"
        right={
          records.length > 0 ? (
            <IconButton accessibilityLabel="Ryd sendte mails" onPress={handleClear}>
              <Trash2 size={16} color={papirColor.ink2} strokeWidth={1.8} />
            </IconButton>
          ) : undefined
        }
      />

      {records.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <Send size={26} color={papirColor.ink3} strokeWidth={1.5} />
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Ingen sendte mails endnu
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Når Zolva sender en mail for dig, dukker den op her — så du altid kan se, hvad der er sendt.
          </PaperText>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.label}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                paddingHorizontal: papirSpace.screen,
                paddingTop: papirSpace.xl,
                paddingBottom: papirSpace.sm,
              }}
            >
              <PaperText role="eyebrow" color={papirColor.ink3}>
                {g.label}
              </PaperText>
              <PaperText role="eyebrow" color={papirColor.ink3} tabular>
                {String(g.items.length)}
              </PaperText>
            </View>
            {g.items.map((rec, i) => (
              <View key={rec.id}>
                <SentRow
                  record={rec}
                  expanded={expandedId === rec.id}
                  onToggle={() => setExpandedId((cur) => (cur === rec.id ? null : rec.id))}
                />
                {i < g.items.length - 1 ? (
                  <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginHorizontal: papirSpace.screen }} />
                ) : null}
              </View>
            ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}

function SentRow({
  record,
  expanded,
  onToggle,
}: {
  record: SentMailRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sentAt = new Date(record.sentAt);
  const recipients = record.to.join(', ') || '–';
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={record.subject || 'Mail uden emne'}
      style={({ pressed }) => ({
        paddingVertical: 12,
        paddingHorizontal: papirSpace.screen,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <PaperText role="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
          {record.subject || '(uden emne)'}
        </PaperText>
        <PaperText role="caption" color={papirColor.ink4} tabular>
          {clock(sentAt)}
        </PaperText>
      </View>
      <PaperText role="caption" color={papirColor.ink3} numberOfLines={1} style={{ marginTop: 2 }}>
        Til: {recipients}
      </PaperText>
      <PaperText role="caption" color={papirColor.ink4} style={{ marginTop: 2 }}>
        {PROVIDER_LABEL[record.provider]}
        {record.replyToId ? ' · svar' : ''}
      </PaperText>
      {expanded ? (
        <View
          style={{
            marginTop: papirSpace.md,
            paddingTop: papirSpace.md,
            borderTopWidth: 1,
            borderTopColor: papirColor.lineSoft,
            gap: 6,
          }}
        >
          {record.cc && record.cc.length > 0 ? (
            <PaperText role="caption" color={papirColor.ink3}>
              Cc: {record.cc.join(', ')}
            </PaperText>
          ) : null}
          <PaperText role="body" color={papirColor.ink}>
            {record.body}
          </PaperText>
        </View>
      ) : null}
    </Pressable>
  );
}
