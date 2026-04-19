import { Check, Trash2 } from 'lucide-react-native';
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EmptyState } from '../components/EmptyState';
import { useChromeInsets } from '../components/PhoneChrome';
import { Stone } from '../components/Stone';
import { formatToday } from '../lib/date';
import { useNotes, useReminders } from '../lib/hooks';
import type { Note, NoteCategory, Reminder } from '../lib/types';
import { colors, fonts } from '../theme';

const CATEGORY_LABEL: Record<NoteCategory, string> = {
  task: 'Opgaver',
  idea: 'Idéer',
  note: 'Noter',
  info: 'Info',
};

const CATEGORY_ORDER: NoteCategory[] = ['task', 'idea', 'note', 'info'];

const CATEGORY_TONE: Record<NoteCategory, { bg: string; fg: string }> = {
  task: { bg: colors.claySoft, fg: colors.clayInk },
  idea: { bg: colors.sageSoft, fg: colors.sageDeep },
  note: { bg: colors.mist, fg: colors.fg2 },
  info: { bg: colors.warningSoft, fg: colors.warningInk },
};

type Props = { onOpenChat: () => void };

export function MemoryScreen({ onOpenChat }: Props) {
  const today = useMemo(() => new Date(), []);
  const date = useMemo(() => formatToday(today), [today]);

  const { data: reminders, markDone, remove: removeReminder } = useReminders();
  const { data: notes, remove: removeNote } = useNotes();

  const pendingReminders = useMemo(
    () => reminders.filter((r) => r.status === 'pending').sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime()),
    [reminders],
  );

  const notesByCategory = useMemo(() => {
    const groups: Record<NoteCategory, Note[]> = { task: [], idea: [], note: [], info: [] };
    for (const n of notes) groups[n.category].push(n);
    return groups;
  }, [notes]);

  const isEmpty = pendingReminders.length === 0 && notes.length === 0;
  const { bottom: chromeBottom } = useChromeInsets();

  return (
    <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]} showsVerticalScrollIndicator={false} contentInsetAdjustmentBehavior="never">
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>{`Husk · ${date.weekdayShort} ${date.day} ${date.monthShort}`}</Text>
        <Text style={styles.heroH1}>Husk</Text>
        <View style={styles.statsRow}>
          <Text style={styles.statBig}>{pendingReminders.length}</Text>
          <Text style={styles.statLabel}>Påmindelser</Text>
          <View style={styles.statDot} />
          <Text style={styles.statBig}>{notes.length}</Text>
          <Text style={styles.statLabel}>Noter</Text>
        </View>
      </View>

      <View style={styles.speech}>
        <Stone mood="thinking" size={40} onPress={onOpenChat} />
        <View style={{ flex: 1 }}>
          <Text style={styles.speechText}>
            Tilføj nye ved at skrive{' '}
            <Text style={styles.accent}>„mind mig om…"</Text> eller{' '}
            <Text style={styles.accent}>„husk at…"</Text> til mig.
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Påmindelser</Text>
          <Text style={styles.sectionMeta}>
            {pendingReminders.length > 0 ? `${pendingReminders.length} aktive` : '-'}
          </Text>
        </View>
        <View style={styles.inkRule} />
        {pendingReminders.length === 0 ? (
          <EmptyState
            icon={false}
            title="Ingen aktive påmindelser"
            body={'Skriv „mind mig om at ringe til Lars torsdag" - så lægger jeg den her.'}
            ctaLabel="Skriv til Zolva"
            onCta={onOpenChat}
          />
        ) : (
          pendingReminders.map((r, i) => (
            <ReminderRow
              key={r.id}
              reminder={r}
              now={today}
              onDone={() => markDone(r.id)}
              onDelete={() => removeReminder(r.id)}
              border={i > 0}
            />
          ))
        )}
      </View>

      <View style={[styles.section, { paddingTop: 28 }]}>
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>Noter</Text>
          <Text style={styles.sectionMeta}>
            {notes.length > 0 ? `${notes.length} gemt` : '-'}
          </Text>
        </View>
        <View style={styles.inkRule} />
        {notes.length === 0 ? (
          <EmptyState
            icon={false}
            title="Din anden hjerne er tom"
            body={'Sig „husk at vi vil prøve grøn te-leverandør" - jeg sorterer det selv.'}
            ctaLabel="Skriv til Zolva"
            onCta={onOpenChat}
          />
        ) : (
          CATEGORY_ORDER.filter((c) => notesByCategory[c].length > 0).map((category) => (
            <View key={category} style={styles.categoryGroup}>
              <View style={styles.categoryHead}>
                <View style={[styles.categoryPill, { backgroundColor: CATEGORY_TONE[category].bg }]}>
                  <Text style={[styles.categoryPillText, { color: CATEGORY_TONE[category].fg }]}>
                    {CATEGORY_LABEL[category]}
                  </Text>
                </View>
                <Text style={styles.categoryCount}>{notesByCategory[category].length}</Text>
              </View>
              {notesByCategory[category].map((n, i) => (
                <NoteRow
                  key={n.id}
                  note={n}
                  now={today}
                  onDelete={() => removeNote(n.id)}
                  border={i > 0}
                />
              ))}
            </View>
          ))
        )}
      </View>

      {isEmpty && <View style={{ height: 24 }} />}
    </ScrollView>
  );
}

function ReminderRow({
  reminder,
  now,
  onDone,
  onDelete,
  border,
}: {
  reminder: Reminder;
  now: Date;
  onDone: () => void;
  onDelete: () => void;
  border: boolean;
}) {
  const due = formatDue(reminder.dueAt, now);
  const isOverdue = reminder.dueAt.getTime() < now.getTime();
  return (
    <View style={[styles.row, border && styles.rowBorder]}>
      <View style={styles.timeCol}>
        <Text style={[styles.timeTop, isOverdue && styles.timeOverdue]}>{due.head}</Text>
        <Text style={styles.timeMeta}>{due.meta}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{reminder.text}</Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable onPress={onDone} style={styles.doneBtn} hitSlop={8}>
          <Check size={16} color={colors.sageDeep} strokeWidth={2.2} />
        </Pressable>
        <Pressable onPress={onDelete} style={styles.deleteBtn} hitSlop={8}>
          <Trash2 size={15} color={colors.fg4} strokeWidth={1.75} />
        </Pressable>
      </View>
    </View>
  );
}

function NoteRow({
  note,
  now,
  onDelete,
  border,
}: {
  note: Note;
  now: Date;
  onDelete: () => void;
  border: boolean;
}) {
  return (
    <View style={[styles.noteRow, border && styles.rowBorder]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.noteText}>{note.text}</Text>
        <Text style={styles.noteMeta}>{relative(note.createdAt, now)}</Text>
      </View>
      <Pressable onPress={onDelete} style={styles.deleteBtn} hitSlop={8}>
        <Trash2 size={15} color={colors.fg4} strokeWidth={1.75} />
      </Pressable>
    </View>
  );
}

function formatDue(due: Date, now: Date): { head: string; meta: string } {
  const diffMs = due.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const diffH = Math.round(diffMin / 60);
  const sameDay =
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate();
  const head = `${pad(due.getHours())}.${pad(due.getMinutes())}`;
  if (diffMin < 0) return { head, meta: 'Forfalden' };
  if (sameDay) {
    if (diffMin < 60) return { head, meta: `om ${diffMin} min` };
    return { head, meta: `om ${diffH} t` };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    due.getFullYear() === tomorrow.getFullYear() &&
    due.getMonth() === tomorrow.getMonth() &&
    due.getDate() === tomorrow.getDate();
  if (isTomorrow) return { head, meta: 'i morgen' };
  return { head, meta: `${pad(due.getDate())} ${formatToday(due).monthShort}` };
}

function relative(then: Date, now: Date): string {
  const diffMin = Math.round((now.getTime() - then.getTime()) / 60000);
  if (diffMin < 1) return 'lige nu';
  if (diffMin < 60) return `${diffMin} min siden`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} t siden`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD} d siden`;
  return `${pad(then.getDate())} ${formatToday(then).monthShort}`;
}

const pad = (n: number) => n.toString().padStart(2, '0');

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
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.88,
    textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 12,
    fontFamily: fonts.displayItalic,
    fontSize: 36,
    lineHeight: 40,
    letterSpacing: -1.08,
    color: colors.ink,
  },
  statsRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  statBig: {
    fontFamily: fonts.display, fontSize: 36,
    letterSpacing: -1.08, lineHeight: 40, color: colors.ink,
  },
  statLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
    marginRight: 4,
  },
  statDot: {
    width: 3, height: 3, borderRadius: 999,
    backgroundColor: colors.fg4,
    marginHorizontal: 6,
    alignSelf: 'center',
  },

  speech: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 24 },
  speechText: {
    fontFamily: fonts.display, fontSize: 18, lineHeight: 26,
    letterSpacing: -0.27, color: colors.ink,
  },
  accent: { color: colors.sageDeep, fontFamily: fonts.displayItalic },

  section: { paddingHorizontal: 20, paddingTop: 28 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', marginBottom: 4,
  },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  sectionMeta: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  inkRule: { height: 1, backgroundColor: colors.ink, marginBottom: 2 },

  row: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 14 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  timeCol: { width: 72 },
  timeTop: {
    fontFamily: fonts.display, fontSize: 18,
    letterSpacing: -0.36, lineHeight: 22, color: colors.ink,
  },
  timeOverdue: { color: colors.warningInk },
  timeMeta: {
    marginTop: 2, fontFamily: fonts.mono, fontSize: 10,
    letterSpacing: 0.6, textTransform: 'uppercase', color: colors.fg3,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.ink },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneBtn: {
    width: 32, height: 32, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.sage,
    backgroundColor: colors.sageSoft,
  },

  categoryGroup: { paddingTop: 14, paddingBottom: 4 },
  categoryHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 6,
  },
  categoryPill: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  categoryPillText: {
    fontFamily: fonts.uiSemi, fontSize: 11.5, letterSpacing: 0.2,
  },
  categoryCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },

  noteRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 12,
  },
  noteText: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.ink },
  noteMeta: { marginTop: 4, fontFamily: fonts.mono, fontSize: 10, color: colors.fg3 },
  deleteBtn: {
    width: 28, height: 28, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
  },
});
