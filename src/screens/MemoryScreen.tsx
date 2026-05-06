import { Check, Trash2 } from 'lucide-react-native';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { CountUp } from '../components/CountUp';
import { EmptyState } from '../components/EmptyState';
import { FactRow } from '../components/FactRow';
import { useChromeInsets } from '../components/PhoneChrome';
import { formatToday } from '../lib/date';
import { useNotes, useReminders, getPrivacyFlag, hydratePrivacyCache, setPrivacyFlag } from '../lib/hooks';
import { isPendingAndDueOrUpcoming } from '../lib/reminders';
import { deleteAllChatHistory, deleteAllFacts, deleteAllMailEvents, deleteFact, listFacts, listRecentChatMessages, subscribeFactsChanged } from '../lib/profile-store';
import { migrateLocalChatIfNeeded } from '../lib/chat-sync';
import { triggerBackfillRerun } from '../lib/onboarding-backfill';
import { syncMemoryEnabled } from '../lib/user-profile';
import { useAuth } from '../lib/auth';
import type { ChatMessageRow, Fact, Note, NoteCategory, Reminder } from '../lib/types';
import { plural } from '../utils/danish';
import { useTheme } from '../design/useTheme';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { TopBar } from '../design/primitives/TopBar';
import { Stone } from '../components/Stone';

const CATEGORY_LABEL: Record<NoteCategory, string> = {
  task: 'Opgaver',
  idea: 'Idéer',
  note: 'Noter',
  info: 'Info',
};

const CATEGORY_ORDER: NoteCategory[] = ['task', 'idea', 'note', 'info'];

type MemoryTab = 'noter' | 'fakta' | 'samtaler';

const MEMORY_TABS: ReadonlyArray<{ id: MemoryTab; label: string }> = [
  { id: 'noter', label: 'Noter' },
  { id: 'fakta', label: 'Fakta' },
  { id: 'samtaler', label: 'Samtaler' },
];

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

type Props = {
  onOpenChat: () => void;
  onOpenNotifications: () => void;
  onOpenSettings: () => void;
};

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

export function MemoryScreen({ onOpenChat, onOpenNotifications, onOpenSettings }: Props) {
  const today = useMemo(() => new Date(), []);

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

  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { bottom: chromeBottom } = useChromeInsets();

  // Category tints derived from signal colors — kept inline to avoid bloating surface tokens.
  const CATEGORY_TONE = useMemo((): Record<NoteCategory, { bg: string; fg: string }> => ({
    task: { bg: surface.warningTint, fg: t.today },
    idea: { bg: 'rgba(176,122,224,0.15)', fg: t.mem },
    note: { bg: 'rgba(15,16,20,0.05)',    fg: t.ink2 },
    info: { bg: 'rgba(255,154,87,0.15)',  fg: t.today },
  }), [surface.warningTint, t.today, t.mem, t.ink2]);

  // Re-fetch when any fact mutation fires
  useEffect(() => subscribeFactsChanged(() => setFactsRev((v) => v + 1)), []);

  useEffect(() => {
    if (!memoryEnabled || !userId) { setFacts([]); setChat([]); return; }
    void listFacts(userId, 'confirmed').then(setFacts).catch(() => setFacts([]));
    void listRecentChatMessages(userId, 100).then(setChat).catch(() => setChat([]));
  }, [memoryEnabled, userId, factsRev]);

  const toggleMemory = async () => {
    const next = !memoryEnabled;
    await setPrivacyFlag('memory-enabled', next);
    if (userId) syncMemoryEnabled(userId, next);
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

  const pendingReminders = useMemo(
    () =>
      reminders
        .filter((r) => isPendingAndDueOrUpcoming(r, today))
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity)),
    [reminders, today],
  );

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

  return (
    <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
      <GlassHaloLayer />
      <ScrollView
        contentContainerStyle={{ paddingBottom: chromeBottom + spacing.xxl }}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
      >
        <TopBar eyebrow="HUSK" onBell={onOpenNotifications} onGear={onOpenSettings} />

        {/* Display headline + tab chips — wrapped in a single glass
            card backdrop so the hero region reads as a unit. */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.cardPad }}>
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg, gap: spacing.lg }}
          >
            <Text style={{ ...type.displayXL, color: t.ink }}>
              {`Det jeg\nhusker.`}
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm - 2, flexWrap: 'wrap' }}>
              {MEMORY_TABS.map((tabDef) => {
                const active = tab === tabDef.id;
                const count =
                  tabDef.id === 'noter' ? notes.length :
                  tabDef.id === 'fakta' ? facts.length :
                  chat.length;
                return (
                  <Pressable key={tabDef.id} onPress={() => setTab(tabDef.id)}>
                    <View style={{
                      paddingVertical: spacing.sm - 1,
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.pill,
                      backgroundColor: active ? t.ink : surface.scrim,
                    }}>
                      <Text style={{
                        fontFamily: fonts.uiBold,
                        fontSize: type.caption.fontSize,
                        color: active ? '#FFFFFF' : t.ink, // #FFFFFF for contrast on dark ink pill
                      }}>
                        {tabDef.label} · <CountUp to={count} style={{
                          fontFamily: fonts.uiBold,
                          fontSize: type.caption.fontSize,
                          color: active ? '#FFFFFF' : t.ink,
                        }} />
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </GlassFrostedCard>
        </View>

        {/* ── Noter tab ── */}
        {tab === 'noter' && (
          <>
            {/* Hint row with Stone */}
            <View style={{
              flexDirection: 'row',
              gap: spacing.md,
              paddingHorizontal: spacing.screenPad,
              paddingTop: spacing.heroPad,
              alignItems: 'flex-start',
            }}>
              <Stone mood="thinking" size={40} onPress={onOpenChat} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.display, fontSize: 18, lineHeight: 26, letterSpacing: -0.27, color: t.ink }}>
                  Tilføj nye ved at skrive{' '}
                  <Text style={{ color: t.mem }}>"mind mig om…"</Text>
                  {' '}eller{' '}
                  <Text style={{ color: t.mem }}>"husk at…"</Text>
                  {' '}til mig.
                </Text>
              </View>
            </View>

            {/* Reminder sections */}
            {hasAnyReminder &&
              reminderSections.map((sec) =>
                sec.items.length === 0 ? null : (
                  <View key={sec.label} style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
                    <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                      {sec.label === 'I dag' ? 'PÅMINDELSER I DAG' : sec.label === 'Kommende' ? 'KOMMENDE' : 'NÅR SOM HELST'}
                    </Text>
                    {sec.label === 'Når som helst' && (
                      <Text style={{ ...type.bodySm, color: t.ink3, paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                        Jeg minder dig løbende indtil du markerer dem som klaret.
                      </Text>
                    )}
                    <View style={{ gap: spacing.sm }}>
                      {sec.items.map((r) => (
                        <ReminderCard
                          key={r.id}
                          reminder={r}
                          now={today}
                          onDone={() => markDone(r.id)}
                          onDelete={() => removeReminder(r.id)}
                          t={t}
                          type={type}
                          fonts={fonts}
                          spacing={spacing}
                          radius={radius}
                        />
                      ))}
                    </View>
                  </View>
                ),
              )}

            {/* Notes by category */}
            <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad, paddingBottom: spacing.md }}>
              <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                NOTER
              </Text>
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
                  <View key={category} style={{ marginBottom: spacing.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                      <View style={{
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: radius.pill,
                        backgroundColor: CATEGORY_TONE[category].bg,
                      }}>
                        <Text style={{
                          fontFamily: fonts.uiBold,
                          fontSize: 11.5,
                          letterSpacing: 0.2,
                          color: CATEGORY_TONE[category].fg,
                        }}>
                          {CATEGORY_LABEL[category]}
                        </Text>
                      </View>
                      <Text style={{ ...type.eyebrow, color: t.ink3 }}>
                        {notesByCategory[category].length}
                      </Text>
                    </View>
                    <View style={{ gap: spacing.sm }}>
                      {notesByCategory[category].map((n) => (
                        <GlassFrostedCard key={n.id} style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: t.ink }}>
                                {n.text}
                              </Text>
                              <Text style={{ ...type.eyebrow, color: t.ink3, marginTop: spacing.xs, textTransform: 'none' }}>
                                {relative(n.createdAt, today)}
                              </Text>
                            </View>
                            <Pressable
                              onPress={() => removeNote(n.id)}
                              hitSlop={8}
                              accessibilityRole="button"
                              accessibilityLabel="Slet"
                            >
                              <Trash2 size={15} color={t.ink4} strokeWidth={1.75} />
                            </Pressable>
                          </View>
                        </GlassFrostedCard>
                      ))}
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {/* ── Fakta tab ── */}
        {tab === 'fakta' && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
            {/* Memory toggle */}
            <GlassFrostedCard style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad, marginBottom: spacing.md }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: t.ink }}>
                  {memoryEnabled ? 'Zolva husker dig' : 'Zolva husker ikke dig'}
                </Text>
                <Pressable
                  onPress={() => { void toggleMemory(); }}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel={memoryEnabled ? 'Slå hukommelse fra' : 'Slå hukommelse til'}
                >
                  <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: t.mem }}>
                    {memoryEnabled ? 'Slå fra' : 'Slå til'}
                  </Text>
                </Pressable>
              </View>
            </GlassFrostedCard>

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
                <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
                  FAKTA OM DIG
                </Text>

                {facts.length === 0 ? (
                  <EmptyState
                    mood="calm"
                    icon={false}
                    title="Ingen fakta endnu"
                    body="Zolva lærer dig at kende gennem jeres samtaler."
                  />
                ) : (
                  // All facts in one GlassFrostedCard, rows separated by a hairline
                  <GlassFrostedCard style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.cardPad }}>
                    {facts.map((f, i) => (
                      <View
                        key={f.id}
                        style={{
                          paddingVertical: spacing.md,
                          borderTopWidth: i > 0 ? 1 : 0,
                          borderTopColor: t.line,
                        }}
                      >
                        <FactRow
                          fact={f}
                          onDelete={() => { void deleteFactAndRefresh(f.id); }}
                        />
                      </View>
                    ))}
                  </GlassFrostedCard>
                )}

                {/* Re-run scan */}
                <Pressable
                  style={{ marginTop: spacing.xl, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: t.line }}
                  onPress={confirmRerunBackfill}
                >
                  <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: t.mem }}>
                    Genscan emails og kalender
                  </Text>
                </Pressable>

                {/* Danger actions */}
                <View style={{ marginTop: spacing.lg, gap: 1 }}>
                  <Pressable
                    style={{ paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: t.line }}
                    onPress={confirmWipeFacts}
                  >
                    <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: '#B34B3A' }}>
                      Slet hele profilen
                    </Text>
                  </Pressable>
                  <Pressable
                    style={{ paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: t.line }}
                    onPress={confirmWipeChat}
                  >
                    <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: '#B34B3A' }}>
                      Slet samtalehistorik
                    </Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Samtaler tab ── */}
        {tab === 'samtaler' && (
          <View style={{ paddingHorizontal: spacing.screenPad, paddingTop: spacing.heroPad }}>
            <Text style={{ ...type.eyebrow, color: t.ink3, fontWeight: '600', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm }}>
              SAMTALER
            </Text>
            {chat.length === 0 ? (
              <EmptyState
                mood="calm"
                icon={false}
                title="Ingen samtalehistorik"
                body="Tidligere beskeder med Zolva vises her, når hukommelse er slået til."
              />
            ) : (
              <GlassFrostedCard style={{ paddingVertical: spacing.xs, paddingHorizontal: spacing.cardPad }}>
                {chat.map((msg, i) => (
                  <View
                    key={msg.id}
                    style={{
                      paddingVertical: spacing.md,
                      borderTopWidth: i > 0 ? 1 : 0,
                      borderTopColor: t.line,
                      gap: spacing.xs,
                    }}
                  >
                    <Text style={{ ...type.eyebrow, color: t.ink3 }}>
                      {msg.role === 'user' ? 'DIG' : msg.role === 'assistant' ? 'ZOLVA' : 'SYSTEM'}
                    </Text>
                    <Text style={{ fontFamily: fonts.ui, fontSize: 14, lineHeight: 20, color: t.ink }} numberOfLines={3}>
                      {msg.content}
                    </Text>
                    <Text style={{ ...type.eyebrow, color: t.ink4, textTransform: 'none' }}>
                      {formatChatTime(msg.createdAt, today)}
                    </Text>
                  </View>
                ))}
              </GlassFrostedCard>
            )}

            {/* Danger action for chat */}
            <Pressable
              style={{ marginTop: spacing.xl, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: t.line }}
              onPress={confirmWipeChat}
            >
              <Text style={{ fontFamily: fonts.ui, fontSize: 14, color: '#B34B3A' }}>
                Slet samtalehistorik
              </Text>
            </Pressable>
          </View>
        )}

      </ScrollView>
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type ThemeSlice = {
  t: ReturnType<typeof useTheme>['t'];
  type: ReturnType<typeof useTheme>['type'];
  fonts: ReturnType<typeof useTheme>['fonts'];
  spacing: ReturnType<typeof useTheme>['spacing'];
  radius: ReturnType<typeof useTheme>['radius'];
};

function ReminderCard({
  reminder,
  now,
  onDone,
  onDelete,
  t,
  type,
  fonts,
  spacing,
  radius,
}: {
  reminder: Reminder;
  now: Date;
  onDone: () => void;
  onDelete: () => void;
} & ThemeSlice) {
  const isDone = reminder.status === 'done';
  const due = reminder.dueAt ? formatDue(reminder.dueAt, now) : { head: 'Ingen tid', meta: '' };
  const isOverdue =
    !isDone && reminder.dueAt != null && reminder.dueAt.getTime() < now.getTime();

  return (
    <GlassFrostedCard style={{
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.cardPad,
      opacity: isDone ? 0.55 : 1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        {/* Checkbox circle */}
        <Pressable
          onPress={isDone ? undefined : onDone}
          disabled={isDone}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={isDone ? 'Klaret' : 'Markér som færdig'}
          accessibilityState={{ disabled: isDone, checked: isDone }}
          style={{
            width: 28,
            height: 28,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: isDone ? t.ink3 : t.mem,
            backgroundColor: isDone ? t.mem : 'transparent',
            flexShrink: 0,
          }}
        >
          {isDone && <Check size={14} color={'#FFFFFF'} strokeWidth={2.2} />}
        </Pressable>

        {/* Text */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{
              fontFamily: fonts.ui,
              fontSize: 14,
              fontWeight: '500',
              color: isDone ? t.ink3 : t.ink,
              textDecorationLine: isDone ? 'line-through' : 'none',
            }}
            numberOfLines={2}
          >
            {reminder.text}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: 2 }}>
            <Text style={{
              fontFamily: fonts.mono,
              fontSize: 10.5,
              color: isOverdue ? t.today : isDone ? t.ink3 : t.mem,
              fontWeight: '600',
            }}>
              {due.head}
            </Text>
            {due.meta !== '' && (
              <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: t.ink4 }}>
                · {isDone ? 'Klaret' : due.meta}
              </Text>
            )}
          </View>
        </View>

        {/* Delete */}
        <Pressable
          onPress={onDelete}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Slet"
        >
          <Trash2 size={15} color={t.ink4} strokeWidth={1.75} />
        </Pressable>
      </View>
    </GlassFrostedCard>
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

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
