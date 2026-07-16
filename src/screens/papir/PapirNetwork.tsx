// Netværk: personerne Zolva husker for dig. Ingen formularer — listen fyldes
// af AI-ekstraktion fra chat og talenoter; lav-konfidens-fund lander øverst
// som "Ny person fundet" med Behold/Afvis (samme mønster som fakta-review).
import React, { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { Search, UserRound } from 'lucide-react-native';
import {
  Button,
  Card,
  ListRow,
  PaperText,
  SegmentedControl,
  papirColor,
  papirRadius,
  papirSpace,
} from '../../design/papir';
import { useNetworkPeople } from '../../lib/hooks';
import type { NetworkFollowup, NetworkPerson } from '../../lib/network-store';
import { usePapirNav } from './nav';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';

const SEGMENTS = ['Seneste', 'A–Å'];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function personOneLiner(p: NetworkPerson): string {
  const work = [p.company, p.role].filter(Boolean).join(' · ');
  return work || p.summary || p.relation || '';
}

function matchesQuery(p: NetworkPerson, q: string): boolean {
  const haystack = [
    p.name, p.company, p.role, p.relation, p.industry, p.howWeMet,
    p.location, p.summary, ...p.traits, ...p.interests, ...p.projects,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

function Avatar({ name }: { name: string }) {
  return (
    <PaperText role="titleSerif" style={{ fontSize: 15 }} color={papirColor.ink2}>
      {initials(name)}
    </PaperText>
  );
}

export function PapirNetwork() {
  const nav = usePapirNav();
  const { data: people, openFollowups, loading, confirm, remove } = useNetworkPeople();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState(0);

  const pending = useMemo(() => people.filter((p) => p.status === 'pending'), [people]);
  const confirmed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = people.filter((p) => p.status === 'confirmed');
    return q ? base.filter((p) => matchesQuery(p, q)) : base;
  }, [people, query]);

  // Forfaldne opfølgninger pr. person → rød "Følg op"-markering på rækken.
  const overdueByPerson = useMemo(() => {
    const now = Date.now();
    const set = new Set<string>();
    for (const f of openFollowups) {
      if (f.dueAt && f.dueAt.getTime() <= now) set.add(f.personId);
    }
    return set;
  }, [openFollowups]);

  const openByPerson = useMemo(() => {
    const map = new Map<string, NetworkFollowup[]>();
    for (const f of openFollowups) {
      const list = map.get(f.personId) ?? [];
      list.push(f);
      map.set(f.personId, list);
    }
    return map;
  }, [openFollowups]);

  const groups = useMemo(() => {
    if (segment === 0) {
      // Seneste: allerede sorteret på updated_at fra store-laget.
      return [{ label: null as string | null, items: confirmed }];
    }
    const sorted = [...confirmed].sort((a, b) => a.name.localeCompare(b.name, 'da'));
    const byLetter = new Map<string, NetworkPerson[]>();
    for (const p of sorted) {
      const letter = (p.name[0] ?? '#').toUpperCase();
      const list = byLetter.get(letter) ?? [];
      list.push(p);
      byLetter.set(letter, list);
    }
    return Array.from(byLetter.entries()).map(([label, items]) => ({ label, items }));
  }, [confirmed, segment]);

  const trailingFor = (p: NetworkPerson): React.ReactNode => {
    if (overdueByPerson.has(p.id)) {
      return (
        <PaperText role="caption" color={papirColor.red}>
          Følg op
        </PaperText>
      );
    }
    const open = openByPerson.get(p.id);
    if (open && open.length > 0) {
      return (
        <PaperText role="caption" color={papirColor.ink3} tabular>
          {open.length === 1 ? '1 opfølgning' : `${open.length} opfølgninger`}
        </PaperText>
      );
    }
    return null;
  };

  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      <PushHeader title="Netværk" />

      {loading ? (
        <View style={{ alignItems: 'center', paddingTop: 80 }}>
          <PapirLoader size={28} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {pending.length > 0 ? (
            <View style={{ paddingHorizontal: papirSpace.screen, gap: 10, marginBottom: papirSpace.sm }}>
              {pending.map((p) => (
                <Card key={p.id}>
                  <PaperText role="eyebrow" color={papirColor.ink3}>
                    Ny person fundet
                  </PaperText>
                  <PaperText role="bodyStrong" style={{ marginTop: 6 }}>
                    {p.name}
                    {p.company ? ` — ${p.company}` : ''}
                  </PaperText>
                  {p.summary ? (
                    <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 3 }}>
                      {p.summary}
                    </PaperText>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: papirSpace.md }}>
                    <Button label="Behold" style={{ flex: 1 }} onPress={() => void confirm(p.id)} />
                    <Button label="Afvis" variant="ghost" style={{ flex: 1 }} onPress={() => void remove(p.id)} />
                  </View>
                </Card>
              ))}
            </View>
          ) : null}

          {people.length === 0 ? (
            <View style={{ alignItems: 'center', paddingTop: 60, paddingHorizontal: papirSpace.xxxl, gap: 10 }}>
              <UserRound size={28} color={papirColor.ink4} strokeWidth={1.6} />
              <PaperText role="bodyStrong" color={papirColor.ink2}>
                Dit netværk er tomt
              </PaperText>
              <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 300 }}>
                Fortæl Zolva om folk du møder — "Jeg mødte Lars fra Volvo…" — i
                chatten eller i en talenote, så husker jeg dem for dig.
              </PaperText>
            </View>
          ) : (
            <>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  marginHorizontal: papirSpace.screen,
                  paddingHorizontal: 14,
                  borderRadius: papirRadius.md,
                  borderWidth: 1,
                  borderColor: papirColor.line,
                  backgroundColor: papirColor.card,
                }}
              >
                <Search size={19} color={papirColor.ink3} strokeWidth={1.8} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Søg på navn, firma eller emne"
                  placeholderTextColor={papirColor.ink4}
                  selectionColor={papirColor.red}
                  style={{ flex: 1, fontSize: 15, color: papirColor.ink, paddingVertical: 12 }}
                  accessibilityLabel="Søg i netværket"
                />
              </View>

              <View style={{ marginHorizontal: papirSpace.screen, marginTop: papirSpace.md }}>
                <SegmentedControl options={SEGMENTS} value={segment} onChange={setSegment} />
              </View>

              {confirmed.length === 0 ? (
                <PaperText
                  role="body"
                  color={papirColor.ink3}
                  style={{ textAlign: 'center', marginTop: 40, paddingHorizontal: papirSpace.xxxl }}
                >
                  Ingen personer matcher "{query.trim()}".
                </PaperText>
              ) : (
                groups.map((g) => (
                  <View key={g.label ?? 'recent'} style={{ marginTop: g.label ? papirSpace.base : papirSpace.sm }}>
                    {g.label ? (
                      <PaperText
                        role="titleSerif"
                        color={papirColor.ink3}
                        style={{ paddingHorizontal: papirSpace.screen, marginBottom: 2 }}
                      >
                        {g.label}
                      </PaperText>
                    ) : null}
                    {g.items.map((p) => (
                      <ListRow
                        key={p.id}
                        leading={<Avatar name={p.name} />}
                        title={p.name}
                        subtitle={personOneLiner(p)}
                        trailing={trailingFor(p)}
                        onPress={() => nav.push('networkPerson', { personId: p.id })}
                      />
                    ))}
                  </View>
                ))
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
