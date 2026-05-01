import { Check, Trash2 } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { EmptyState } from '../components/EmptyState';
import { FactRow } from '../components/FactRow';
import { useChromeInsets } from '../components/PhoneChrome';
import { Stone } from '../components/Stone';
import { formatToday } from '../lib/date';
import { useNotes, useReminders, getPrivacyFlag, hydratePrivacyCache, setPrivacyFlag } from '../lib/hooks';
import { isPendingAndDueOrUpcoming } from '../lib/reminders';
import { deleteAllChatHistory, deleteAllFacts, deleteAllMailEvents, deleteFact, listFacts, listRecentChatMessages, subscribeFactsChanged } from '../lib/profile-store';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';
import { triggerBackfillRerun } from '../lib/onboarding-backfill';
import { useAuth } from '../lib/auth';
import type { ChatMessageRow, Fact, Note, NoteCategory, Reminder } from '../lib/types';
import { colors, fonts } from '../theme';
import { plural } from '../utils/danish';

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

type MemoryTab = 'noter' | 'fakta' | 'samtaler';

const TAB_LABELS: Record<MemoryTab, string> = {
  noter: 'Noter',
  fakta: 'Fakta',
  samtaler: 'Samtaler',
};

function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

type Props = { onOpenChat: () => void };

function useMemoryEnabledLocal(version: number): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => getPrivacyFlag('memory-enabled'));
  useEffect(() => {
    let cancelled = false;
    void hydratePrivacyCache().then(() => {
      if (!cancelled) setEnabled(getPrivacyFlag('memory-enabled'));
    });
    return () => { cancelled = true; };
  }, [version]);
  return enabled;
}

export function MemoryScreen({ onOpenChat }: Props) {
  const today = useMemo(() => new Date(), []);
  const date = useMemo(() => formatToday(today), [today]);

  const { data: reminders, markDone, remove: removeReminder } = useReminders();
  const { data: notes, remove: removeNote } = useNotes();
  const { user } = useAuth();
  const userId = user?.id ?? '';

  const [tab, setTab] = useState<MemoryTab>('noter');
  const [privacyVersion, setPrivacyVersion] = useState(0);
  const memoryEnabled = useMemoryEnabledLocal(privacyVersion);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [chat, setChat] = useState<ChatMessageRow[]>([]);
  const [factsRev, setFactsRev] = useState(0);

  // Re-fetch when any fact mutation fires (confirmFact, rejectFact,
  // bulkUpdatePendingFacts from the onboarding review screen, deleteFact
  // from the row swipe, etc). Without this, facts saved via the chain
  // stay invisible here until the user toggles memory off/on.
  useEffect(() => subscribeFactsChanged(() => setFactsRev((v) => v + 1)), []);

  useEffect(() => {
    if (!memoryEnabled || !userId) { setFacts([]); setChat([]); return; }
    void listFacts(userId, 'confirmed').then(setFacts).catch(() => setFacts([]));
    void listRecentChatMessages(userId, 100).then(setChat).catch(() => setChat([]));
  }, [memoryEnabled, userId, factsRev]);

  const toggleMemory = async () => {
    const next = !memoryEnabled;
    await setPrivacyFlag('memory-enabled', next);
    if (next && userId) void migrateLocalChatIfNeeded(userId);
    setPrivacyVersion((v) => v + 1);
  };

  const deleteFactAndRefresh = async (id: string) => {
    await deleteFact(id);
    if (userId) setFacts((prev) => prev.filter((f) => f.id !== id));
  };

  const confirmRerunBackfill = () => {
    Alert.alert(
      'Genscan dine emails og kalender?',
      'Vi gennemgår dine seneste emails og tilbagevendende møder igen for at finde nye fakta. Allerede gemte fakta er bevaret.',
      [
        { text: 'Annullér', style: 'cancel' },
        { text: 'Genscan', onPress: () => { triggerBackfillRerun(); } },
      ],
    );
  };

  const confirmWipeFacts = () => {
    Alert.alert('Slet hele profilen?', 'Alle fakta Zolva har lært om dig slettes permanent.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Slet', style: 'destructive', onPress: async () => {
        if (!userId) return;
        await deleteAllFacts(userId);
        setFacts([]);
      }},
    ]);
  };

  const confirmWipeChat = () => {
    Alert.alert('Slet samtalehistorik?', 'Alle gemte samtaler og mail-begivenheder slettes permanent.', [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Slet', style: 'destructive', onPress: async () => {
        if (!userId) return;
        await deleteAllChatHistory(userId);
        await deleteAllMailEvents(userId);
        setChat([]);
      }},
    ]);
  };

  // `isPendingAndDueOrUpcoming` drops pending reminders whose dueAt is more
  // than 5 minutes past — once the reminders-fire cron has pushed and the
  // user has had time to act on the notification, the reminder shouldn't
  // keep occupying space in the "Husk" list. Filtering only on
  // `status === 'pending'` left fired reminders sitting on the screen
  // forever until the user manually checked them off.
  const pendingReminders = useMemo(
    () =>
      reminders
        .filter((r) => isPendingAndDueOrUpcoming(r, today))
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)),
    [reminders, today],
  );

  // Keep recently-done reminders visible the rest of the day so the user
  // sees their just-checked-off item before it falls away tomorrow.
  const visibleReminders = useMemo(() => {
    const startToday = startOfToday(today).getTime();
    return reminders.filter(
      (r) =>
        isPendingAndDueOrUpcoming(r, today) ||
        (r.doneAt != null && r.doneAt.getTime() >= startToday),
    );
  }, [reminders, today]);

  const reminderSections = useMemo(() => {
    const endToday = endOfToday(today).getTime();
    const today_ = { label: 'I dag', items: [] as Reminder[] };
    const upcoming = { label: 'Kommende', items: [] as Reminder[] };
    const anytime = { label: 'Når som helst', items: [] as Reminder[] };
    for (const r of visibleReminders) {
      if (r.dueAt == null) {
        anytime.items.push(r);
      } else if (r.dueAt.getTime() <= endToday) {
        today_.items.push(r);
      } else {
        upcoming.items.push(r);
      }
    }
    today_.items.sort(
      (a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity),
    );
    upcoming.items.sort(
      (a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity),
    );
    anytime.items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return [today_, upcoming, anytime];
  }, [visibleReminders, today]);

  const hasAnyReminder = visibleReminders.length > 0;

  const notesByCategory = useMemo(() => {
    const groups: Record<NoteCategory, Note[]> = { task: [], idea: [], note: [], info: [] };
    for (const n of notes) groups[n.category].push(n);
    return groups;
  }, [notes]);

  const isEmpty = notes.length === 0;
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

      {/* Tab row */}
      <View style={styles.tabRow}>
        {(['noter', 'fakta', 'samtaler'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {TAB_LABELS[t]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Fakta tab ── */}
      {tab === 'fakta' && (
        <View style={styles.section}>
          {/* Kill-switch row */}
          <View style={styles.killRow}>
            <Text style={styles.killRowLabel}>
              {memoryEnabled ? 'Zolva husker dig' : 'Zolva husker ikke dig'}
            </Text>
            <Pressable
              onPress={() => { void toggleMemory(); }}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={memoryEnabled ? 'Slå hukommelse fra' : 'Slå hukommelse til'}
            >
              <Text style={styles.killRowAction}>{memoryEnabled ? 'Slå fra' : 'Slå til'}</Text>
            </Pressable>
          </View>

          {!memoryEnabled ? (
            <EmptyState
              mood="calm"
              icon={false}
              title="Hukommelse er slået fra"
              body="Slå hukommelse til for at lade Zolva lære dig at kende over tid."
              ctaLabel="Slå hukommelse til"
              onCta={() => { void toggleMemory(); }}
            />
          ) : (
            <>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>Fakta</Text>
                <Text style={styles.sectionMeta}>
                  {facts.length > 0 ? plural(facts.length, 'gemt', 'gemte') : '-'}
                </Text>
              </View>
              <View style={styles.inkRule} />
              {facts.length === 0 ? (
                <EmptyState
                  mood="calm"
                  icon={false}
                  title="Ingen fakta endnu"
                  body="Zolva lærer dig at kende gennem jeres samtaler."
                />
              ) : (
                facts.map((f, i) => (
                  <View key={f.id} style={i > 0 ? styles.rowBorder : undefined}>
                    <FactRow
                      fact={f}
                      onDelete={() => { void deleteFactAndRefresh(f.id); }}
                    />
                  </View>
                ))
              )}

              {/* Re-run scan */}
              <Pressable style={styles.rerunRow} onPress={confirmRerunBackfill}>
                <Text style={styles.rerunText}>Genscan emails og kalender</Text>
              </Pressable>

              {/* Danger actions */}
              <View style={{ marginTop: 32, gap: 1 }}>
                <Pressable style={styles.dangerRow} onPress={confirmWipeFacts}>
                  <Text style={styles.dangerText}>Slet hele profilen</Text>
                </Pressable>
                <Pressable style={styles.dangerRow} onPress={confirmWipeChat}>
                  <Text style={styles.dangerText}>Slet samtalehistorik</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}

      {/* ── Noter tab ── */}
      {tab === 'noter' && (
        <>
          <View style={styles.speech}>
            <Stone mood="thinking" size={40} onPress={onOpenChat} />
            <View style={{ flex: 1 }}>
              {/* Quote style: standard "…" (straight double quotes). The quoted
                  content here is conversational prompt examples — not editorial
                  citations — and modern Danish digital writing favours "…" over
                  guillemets (»…«) for this register. Keep this consistent across
                  the app; we are the only screen that quotes inline. */}
              <Text style={styles.speechText}>
                Tilføj nye ved at skrive{' '}
                <Text style={styles.accent}>"mind mig om…"</Text> eller{' '}
                <Text style={styles.accent}>"husk at…"</Text> til mig.
              </Text>
            </View>
          </View>

          {hasAnyReminder &&
            reminderSections.map((sec) =>
              sec.items.length === 0 ? null : (
                <View key={sec.label} style={[styles.section, { paddingTop: 24 }]}>
                  <View style={styles.sectionHead}>
                    <Text style={styles.sectionTitle}>{sec.label}</Text>
                    <Text style={styles.sectionMeta}>
                      {plural(sec.items.length, 'aktiv', 'aktive')}
                    </Text>
                  </View>
                  <View style={styles.inkRule} />
                  {sec.label === 'Når som helst' && (
                    <Text style={styles.sectionHint}>
                      Jeg minder dig løbende indtil du markerer dem som klaret.
                    </Text>
                  )}
                  {sec.items.map((r, i) => (
                    <ReminderRow
                      key={r.id}
                      reminder={r}
                      now={today}
                      onDone={() => markDone(r.id)}
                      onDelete={() => removeReminder(r.id)}
                      border={i > 0}
                    />
                  ))}
                </View>
              ),
            )}

          <View style={[styles.section, { paddingTop: 28 }]}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Noter</Text>
              <Text style={styles.sectionMeta}>
                {notes.length > 0 ? plural(notes.length, 'gemt', 'gemte') : '-'}
              </Text>
            </View>
            <View style={styles.inkRule} />
            {notes.length === 0 ? (
              <EmptyState
                icon={false}
                title="Din anden hjerne er tom"
                body={'Sig "husk at vi vil prøve grøn te-leverandør" - jeg sorterer det selv.'}
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
        </>
      )}

      {/* ── Samtaler tab ── */}
      {tab === 'samtaler' && (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Samtaler</Text>
            <Text style={styles.sectionMeta}>
              {chat.length > 0 ? `${chat.length} beskeder` : '-'}
            </Text>
          </View>
          <View style={styles.inkRule} />
          {chat.length === 0 ? (
            <EmptyState
              mood="calm"
              icon={false}
              title="Ingen samtalehistorik"
              body="Tidligere beskeder med Zolva vises her, når hukommelse er slået til."
            />
          ) : (
            chat.map((msg, i) => (
              <View key={msg.id} style={[styles.chatRow, i > 0 && styles.rowBorder]}>
                <Text style={styles.chatRowRole}>
                  {msg.role === 'user' ? 'Dig' : msg.role === 'assistant' ? 'Zolva' : 'System'}
                </Text>
                <Text style={styles.chatRowText} numberOfLines={3}>{msg.content}</Text>
                <Text style={styles.timeMeta}>{formatChatTime(msg.createdAt, today)}</Text>
              </View>
            ))
          )}
        </View>
      )}
    </ScrollView>
  );
}

function formatChatTime(then: Date, now: Date): string {
  const diffMin = Math.round((now.getTime() - then.getTime()) / 60000);
  if (diffMin < 1) return 'lige nu';
  if (diffMin < 60) return `${diffMin} min siden`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} t siden`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD} d siden`;
  return `${pad(then.getDate())} ${formatToday(then).monthShort}`;
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
  const isDone = reminder.status === 'done';
  const due = reminder.dueAt ? formatDue(reminder.dueAt, now) : { head: 'Ingen tid', meta: '' };
  const isOverdue =
    !isDone && reminder.dueAt != null && reminder.dueAt.getTime() < now.getTime();
  return (
    <View style={[styles.row, border && styles.rowBorder, isDone && styles.rowDone]}>
      <View style={styles.timeCol}>
        <Text
          style={[
            styles.timeTop,
            isOverdue && styles.timeOverdue,
            isDone && styles.timeDone,
          ]}
        >
          {due.head}
        </Text>
        <Text style={styles.timeMeta}>{isDone ? 'Klaret' : due.meta}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, isDone && styles.rowTitleDone]}>{reminder.text}</Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          onPress={isDone ? undefined : onDone}
          disabled={isDone}
          style={[styles.doneBtn, isDone && styles.doneBtnFilled]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={isDone ? 'Klaret' : 'Markér som færdig'}
          accessibilityState={{ disabled: isDone, checked: isDone }}
        >
          <Check
            size={16}
            color={isDone ? colors.paper : colors.sageDeep}
            strokeWidth={2.2}
          />
        </Pressable>
        <Pressable
          onPress={onDelete}
          style={styles.deleteBtn}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Slet"
        >
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
      <Pressable
        onPress={onDelete}
        style={styles.deleteBtn}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Slet"
      >
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

  // ── Tab row ──────────────────────────────────────────────────────────────
  tabRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
    gap: 4,
    backgroundColor: colors.paper,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: colors.sageSoft,
  },
  tabText: {
    fontFamily: fonts.uiSemi,
    fontSize: 12,
    letterSpacing: 0.4,
    color: colors.fg3,
    textTransform: 'uppercase',
  },
  tabTextActive: {
    color: colors.sageDeep,
  },

  // ── Kill-switch ───────────────────────────────────────────────────────────
  killRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  killRowLabel: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.ink,
  },
  killRowAction: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    color: colors.sageDeep,
  },

  // ── Re-run scan ───────────────────────────────────────────────────────────
  rerunRow: {
    marginTop: 24,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rerunText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.sageDeep,
  },

  // ── Danger actions ────────────────────────────────────────────────────────
  dangerRow: {
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  dangerText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.danger,
  },

  // ── Chat rows ─────────────────────────────────────────────────────────────
  chatRow: {
    paddingVertical: 12,
    gap: 2,
  },
  chatRowRole: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.fg3,
    marginBottom: 2,
  },
  chatRowText: {
    fontFamily: fonts.ui,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
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
  sectionHint: {
    marginTop: 6,
    fontFamily: fonts.ui,
    fontSize: 12,
    lineHeight: 18,
    color: colors.fg3,
  },
  inkRule: { height: 1, backgroundColor: colors.ink, marginBottom: 2 },

  row: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 14 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowDone: { opacity: 0.5 },
  timeCol: { width: 72 },
  timeTop: {
    fontFamily: fonts.display, fontSize: 18,
    letterSpacing: -0.36, lineHeight: 22, color: colors.ink,
  },
  timeOverdue: { color: colors.warningInk },
  timeDone: { color: colors.fg3 },
  timeMeta: {
    marginTop: 2, fontFamily: fonts.mono, fontSize: 10,
    letterSpacing: 0.6, textTransform: 'uppercase', color: colors.fg3,
  },
  rowBody: { flex: 1 },
  rowTitle: { fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: colors.ink },
  rowTitleDone: { textDecorationLine: 'line-through', color: colors.fg3 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  doneBtn: {
    width: 32, height: 32, borderRadius: 999,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.sage,
    backgroundColor: colors.sageSoft,
  },
  doneBtnFilled: {
    backgroundColor: colors.sageDeep,
    borderColor: colors.sageDeep,
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
