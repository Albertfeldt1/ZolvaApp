import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { Check, MessageSquare, Sparkles, X } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, SegmentedControl, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { useAuth } from '../../lib/auth';
import { useMemoryEnabled, useNotes } from '../../lib/hooks';
import {
  confirmFact,
  deleteAllChatHistory,
  deleteAllFacts,
  deleteAllMailEvents,
  deleteFact,
  listFacts,
  listPendingFactsForReview,
  listRecentChatMessages,
  rejectFact,
  subscribeFactsChanged,
} from '../../lib/profile-store';
import type { ChatMessageRow, Fact, Note } from '../../lib/types';
import { usePapirScreenPads } from './insets';
import { PapirLoader } from './PapirLoader';
import { PapirTag } from './PapirTag';
import { useNow } from './useNow';

function GroupLabel({ children }: { children: string }) {
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

const WEEKDAYS_SHORT = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

// Cross-screen segment request (same module-store pattern as papir-flag):
// "Noter"/"Mine noter" shortcuts land on THIS tab but must select the right
// segment — nav.setTab carries no params, and the keep-alive tab may or may
// not be mounted yet, so a pending value + listener covers both cases.
export type HistorySegment = 0 | 1 | 2 | 3; // Optagelser · Noter · Fakta · Samtaler
let pendingSegment: HistorySegment | null = null;
let pendingHighlightId: string | null = null;
const segmentListeners = new Set<() => void>();

/** Ask Historik to show a segment; call right before nav.setTab('history').
 * Pass a note id to flash that row so the user lands ON the item they tapped
 * (QA M9 — search results used to dump them at the top of the list). */
export function requestHistorySegment(segment: HistorySegment, highlightId?: string): void {
  pendingSegment = segment;
  pendingHighlightId = highlightId ?? null;
  segmentListeners.forEach((l) => l());
}

function trailingFor(note: Note, now: Date): string {
  const d = note.createdAt;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo < 7) return WEEKDAYS_SHORT[d.getDay()];
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function durationLabel(sec?: number): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} min` : `${s} sek`;
}

type Group = { label: string; items: Note[] };

function groupByDay(notes: Note[], now: Date): Group[] {
  const today: Note[] = [];
  const yesterday: Note[] = [];
  const earlier: Note[] = [];
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  notes.forEach((n) => {
    const ds = n.createdAt.toDateString();
    if (ds === now.toDateString()) today.push(n);
    else if (ds === y.toDateString()) yesterday.push(n);
    else earlier.push(n);
  });
  return [
    { label: 'I dag', items: today },
    { label: 'I går', items: yesterday },
    { label: 'Tidligere', items: earlier },
  ].filter((g) => g.items.length > 0);
}

/** Fakta: what Zolva has learned — pending facts to review (accept/reject)
 * plus confirmed facts (long-press delete). Memory parity from the classic
 * MemoryScreen's Fakta tab, re-homed per the Papir IA decision. */
function FaktaView() {
  const { user } = useAuth();
  const memoryEnabled = useMemoryEnabled();
  const [pending, setPending] = useState<Fact[]>([]);
  const [confirmed, setConfirmed] = useState<Fact[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user?.id) {
      setPending([]);
      setConfirmed([]);
      setLoading(false);
      return;
    }
    try {
      const [p, c] = await Promise.all([
        listPendingFactsForReview(user.id),
        listFacts(user.id, 'confirmed'),
      ]);
      setPending(p);
      setConfirmed(c);
    } catch {
      // Keep whatever we had; the retry path is the facts-changed bus or a
      // segment revisit. Never blank good data on a flaky fetch.
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void reload();
    return subscribeFactsChanged(() => void reload());
  }, [reload]);

  const decide = async (fact: Fact, accept: boolean) => {
    // Optimistic: the row leaves the review list immediately.
    setPending((prev) => prev.filter((f) => f.id !== fact.id));
    if (accept) setConfirmed((prev) => [fact, ...prev]);
    try {
      await (accept ? confirmFact(fact.id) : rejectFact(fact.id));
    } catch {
      Alert.alert('Fakta', 'Kunne ikke gemme din vurdering. Prøv igen.');
      void reload();
    }
  };

  const confirmDeleteFact = (fact: Fact) => {
    Alert.alert('Slet faktum', `"${fact.text}"`, [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Slet',
        style: 'destructive',
        onPress: async () => {
          setConfirmed((prev) => prev.filter((f) => f.id !== fact.id));
          try {
            await deleteFact(fact.id);
          } catch {
            Alert.alert('Fakta', 'Kunne ikke slette. Prøv igen.');
            void reload();
          }
        },
      },
    ]);
  };

  const confirmDeleteAll = () => {
    if (!user?.id || confirmed.length === 0) return;
    Alert.alert('Slet alle fakta?', 'Alt Zolva har lært om dig slettes permanent.', [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Slet alt',
        style: 'destructive',
        onPress: async () => {
          const uid = user.id;
          setConfirmed([]);
          setPending([]);
          try {
            await deleteAllFacts(uid);
          } catch {
            Alert.alert('Fakta', 'Kunne ikke slette alt. Prøv igen.');
            void reload();
          }
        },
      },
    ]);
  };

  if (!memoryEnabled) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
        <PaperText role="bodyStrong" color={papirColor.ink2}>
          Hukommelse er slået fra
        </PaperText>
        <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
          Slå &ldquo;Lad Zolva lære dig at kende&rdquo; til under Indstillinger → Privatliv, så samles fakta her.
        </PaperText>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 60 }}>
        <PapirLoader />
      </View>
    );
  }

  if (pending.length === 0 && confirmed.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
        <PaperText role="bodyStrong" color={papirColor.ink2}>
          Ingen fakta endnu
        </PaperText>
        <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
          Zolva lærer dig at kende gennem jeres samtaler og dine mails.
        </PaperText>
      </View>
    );
  }

  return (
    <View>
      {pending.length > 0 ? (
        <>
          <GroupLabel>Til gennemsyn</GroupLabel>
          {pending.map((f) => (
            <View
              key={f.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 12,
                paddingHorizontal: papirSpace.screen,
              }}
            >
              <Sparkles size={16} color={papirColor.red} strokeWidth={1.8} />
              <PaperText role="body" style={{ flex: 1 }}>
                {f.text}
              </PaperText>
              <ScaleButton
                scaleTo={0.9}
                haptic="light"
                onPress={() => void decide(f, false)}
                accessibilityRole="button"
                accessibilityLabel="Afvis faktum"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  borderWidth: 1,
                  borderColor: papirColor.line,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={15} color={papirColor.ink2} strokeWidth={2} />
              </ScaleButton>
              <ScaleButton
                scaleTo={0.9}
                haptic="light"
                onPress={() => void decide(f, true)}
                accessibilityRole="button"
                accessibilityLabel="Bekræft faktum"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  backgroundColor: papirColor.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Check size={15} color="#FFFFFF" strokeWidth={2.4} />
              </ScaleButton>
            </View>
          ))}
        </>
      ) : null}

      {confirmed.length > 0 ? (
        <>
          <GroupLabel>Det ved Zolva</GroupLabel>
          {confirmed.map((f, i) => (
            <View key={f.id}>
              <Pressable
                onLongPress={() => confirmDeleteFact(f)}
                accessibilityLabel={f.text}
                accessibilityHint="Hold nede for at slette"
                style={{ paddingVertical: 12, paddingHorizontal: papirSpace.screen }}
              >
                <PaperText role="body">{f.text}</PaperText>
              </Pressable>
              {i < confirmed.length - 1 ? (
                <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
              ) : null}
            </View>
          ))}
          <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 20 }}>
            <Button label="Slet alle fakta" variant="ghost" onPress={confirmDeleteAll} />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Samtaler: the synced chat history + the classic 'wipe it all' escape
 * hatch (chat + mail events) — Memory parity from MemoryScreen. */
function SamtalerView() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const now = useNow();

  const reload = useCallback(async () => {
    if (!user?.id) {
      setMessages([]);
      setLoading(false);
      return;
    }
    try {
      setMessages(await listRecentChatMessages(user.id, 100));
    } catch {
      // Keep previous list on flaky fetch.
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const confirmWipe = () => {
    if (!user?.id) return;
    Alert.alert('Slet samtalehistorik?', 'Alle gemte samtaler og mail-begivenheder slettes permanent.', [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Slet alt',
        style: 'destructive',
        onPress: async () => {
          const uid = user.id;
          setMessages([]);
          try {
            await deleteAllChatHistory(uid);
            await deleteAllMailEvents(uid);
          } catch {
            Alert.alert('Samtaler', 'Kunne ikke slette alt. Prøv igen.');
            void reload();
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 60 }}>
        <PapirLoader />
      </View>
    );
  }

  if (messages.length === 0) {
    return (
      <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
        <PaperText role="bodyStrong" color={papirColor.ink2}>
          Ingen gemte samtaler
        </PaperText>
        <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
          Samtaler med Zolva gemmes her, medmindre du har valgt kun at gemme lokalt.
        </PaperText>
      </View>
    );
  }

  return (
    <View>
      <GroupLabel>Seneste beskeder</GroupLabel>
      {messages
        .filter((m) => m.role !== 'tool')
        .map((m, i, arr) => (
          <View key={m.id}>
            <View style={{ paddingVertical: 10, paddingHorizontal: papirSpace.screen, flexDirection: 'row', gap: 12 }}>
              <MessageSquare
                size={15}
                color={m.role === 'user' ? papirColor.ink3 : papirColor.red}
                strokeWidth={1.8}
                style={{ marginTop: 3 }}
              />
              <View style={{ flex: 1 }}>
                <PaperText role="caption" color={papirColor.ink3}>
                  {m.role === 'user' ? 'Dig' : 'Zolva'} · {relTime(m.createdAt, now)}
                </PaperText>
                <PaperText role="body" numberOfLines={3} style={{ marginTop: 2 }}>
                  {m.content}
                </PaperText>
              </View>
            </View>
            {i < arr.length - 1 ? (
              <View style={{ height: 1, backgroundColor: papirColor.lineSoft, marginHorizontal: papirSpace.screen }} />
            ) : null}
          </View>
        ))}
      <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 20 }}>
        <Button label="Slet samtalehistorik" variant="ghost" onPress={confirmWipe} />
      </View>
    </View>
  );
}

function relTime(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo >= 0 && daysAgo < 7) return WEEKDAYS_SHORT[d.getDay()];
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function PapirHistory() {
  const pads = usePapirScreenPads();
  const notes = useNotes();
  const [segment, setSegment] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const now = useNow();

  // Consume segment requests from shortcuts — both one that arrived before
  // this tab first mounted (pending) and later ones while kept alive.
  useEffect(() => {
    const apply = () => {
      if (pendingSegment === null) return;
      setSegment(pendingSegment);
      pendingSegment = null;
      if (pendingHighlightId !== null) {
        setHighlightId(pendingHighlightId);
        pendingHighlightId = null;
      }
    };
    apply();
    segmentListeners.add(apply);
    return () => {
      segmentListeners.delete(apply);
    };
  }, []);

  // The flash is transient by design — a lasting tint would read as a state.
  useEffect(() => {
    if (!highlightId) return;
    const t = setTimeout(() => setHighlightId(null), 2_200);
    return () => clearTimeout(t);
  }, [highlightId]);

  const shown = useMemo(() => {
    const wantVoice = segment === 0;
    const filtered = notes.data.filter((n) => (n.source === 'voice') === wantVoice);
    // Newest first — the store appends chronologically.
    return [...filtered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }, [notes.data, segment]);

  const groups = useMemo(() => groupByDay(shown, now), [shown, now]);

  const confirmDelete = (note: Note) => {
    Alert.alert('Slet', `Slet "${note.title ?? note.text.slice(0, 40)}"?`, [
      { text: 'Annullér', style: 'cancel' },
      { text: 'Slet', style: 'destructive', onPress: () => notes.remove(note.id) },
    ]);
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingTop: pads.top, paddingBottom: pads.bottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ paddingHorizontal: papirSpace.screen }}>
        <PaperText role="eyebrow" color={papirColor.ink3}>
          Alt du har sagt
        </PaperText>
        <PaperText role="displayM" style={{ marginTop: 8 }}>
          Historik
        </PaperText>
        <View style={{ marginTop: 18 }}>
          <SegmentedControl options={['Optagelser', 'Noter', 'Fakta', 'Samtaler']} value={segment} onChange={setSegment} />
        </View>
      </View>

      {segment === 2 ? (
        <FaktaView />
      ) : segment === 3 ? (
        <SamtalerView />
      ) : groups.length === 0 ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            {segment === 0 ? 'Ingen optagelser endnu' : 'Ingen noter endnu'}
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center' }}>
            {segment === 0
              ? 'Tryk på den røde knap for at optage din første stemme-note.'
              : 'Bed Zolva i chatten om at gemme en note — de samles her.'}
          </PaperText>
        </View>
      ) : (
        groups.map((g) => (
          <View key={g.label}>
            <GroupLabel>{g.label}</GroupLabel>
            {g.items.map((note, i) => {
              const dur = durationLabel(note.durationSec);
              return (
                <View
                  key={note.id}
                  style={highlightId === note.id ? { backgroundColor: papirColor.redSoft, borderRadius: 12 } : null}
                >
                  {/* Approved-design row anatomy: category tag + time header,
                      note text underneath — the tag color IS the row's type
                      signal (talenote red, note slate), so no leading icon. */}
                  <Pressable
                    onLongPress={() => confirmDelete(note)}
                    accessibilityLabel={note.title ?? note.text.slice(0, 40)}
                    accessibilityHint="Hold nede for at slette"
                    style={{ paddingHorizontal: papirSpace.screen, paddingVertical: 14 }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <PapirTag
                        label={note.source === 'voice' ? 'Talenote' : 'Note'}
                        kind={note.source === 'voice' ? 'talenote' : 'note'}
                      />
                      <PaperText role="caption" color={papirColor.ink4} tabular>
                        {trailingFor(note, now)}
                        {dur ? ` · ${dur}` : ''}
                      </PaperText>
                    </View>
                    <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 8 }} numberOfLines={2}>
                      {note.title ?? note.text}
                    </PaperText>
                  </Pressable>
                  {i < g.items.length - 1 ? (
                    <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen }} />
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
