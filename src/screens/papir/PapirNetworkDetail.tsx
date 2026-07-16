// Personkort i Netværk: AI-resumé, profilfelter, kendetegn/interesser,
// opfølgninger med done-toggle og interaktions-tidslinje. Redigering låser
// felterne mod senere AI-overskrivning (user_edited_fields via byUser-flaget
// i updateNetworkPersonFields).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import {
  Calendar,
  Check,
  FileText,
  Mail,
  MessageSquare,
  Mic,
  PenLine,
  Trash2,
  Users,
} from 'lucide-react-native';
import {
  Button,
  Card,
  IconButton,
  PaperText,
  papirColor,
  papirRadius,
  papirSpace,
} from '../../design/papir';
import { ScaleButton } from '../../design/motion';
import { useNetworkPerson } from '../../lib/hooks';
import type {
  EditablePersonFields,
  NetworkInteraction,
  NetworkInteractionKind,
} from '../../lib/network-store';
import { usePapirNav } from './nav';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';

const MONTHS_SHORT = ['jan.', 'feb.', 'mar.', 'apr.', 'maj', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];

function formatShortDate(d: Date): string {
  const now = new Date();
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()}. ${MONTHS_SHORT[d.getMonth()]}${year}`;
}

type IconCmp = React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const KIND_ICONS: Record<NetworkInteractionKind, IconCmp> = {
  chat: MessageSquare,
  voice: Mic,
  note: FileText,
  meeting: Users,
  mail: Mail,
  calendar: Calendar,
  manual: PenLine,
};

// Redigerbare skalar-felter i den rækkefølge de vises/redigeres.
const EDIT_FIELDS: Array<{ key: keyof EditablePersonFields & string; label: string }> = [
  { key: 'name', label: 'Navn' },
  { key: 'company', label: 'Firma' },
  { key: 'role', label: 'Stilling' },
  { key: 'relation', label: 'Relation' },
  { key: 'industry', label: 'Branche' },
  { key: 'howWeMet', label: 'Mødt' },
  { key: 'location', label: 'Bor' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefon' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'notes', label: 'Noter' },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginTop: papirSpace.xl, marginBottom: papirSpace.sm }}>
      {children}
    </PaperText>
  );
}

function PillRow({ items }: { items: string[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {items.map((t) => (
        <View
          key={t}
          style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: papirRadius.pill,
            borderWidth: 1,
            borderColor: papirColor.line,
            backgroundColor: papirColor.card,
          }}
        >
          <PaperText role="caption" color={papirColor.ink2}>
            {t}
          </PaperText>
        </View>
      ))}
    </View>
  );
}

function InteractionRow({ interaction }: { interaction: NetworkInteraction }) {
  const Icon = KIND_ICONS[interaction.kind] ?? PenLine;
  return (
    <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 10 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: papirRadius.sm,
          backgroundColor: papirColor.paper2,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        <Icon size={14} color={papirColor.ink3} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1 }}>
        <PaperText role="body" color={papirColor.ink}>
          {interaction.summary}
        </PaperText>
        <PaperText role="caption" color={papirColor.ink4} tabular style={{ marginTop: 2 }}>
          {formatShortDate(interaction.occurredAt)}
        </PaperText>
      </View>
    </View>
  );
}

export function PapirNetworkDetail({ personId }: { personId?: string }) {
  const nav = usePapirNav();
  const { data: bundle, loading, updateFields, toggleFollowup, remove } = useNetworkPerson(personId ?? null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const person = bundle?.person ?? null;

  const dirty = useMemo(() => {
    if (!editing || !person) return false;
    return EDIT_FIELDS.some(({ key }) => {
      const current = (person as unknown as Record<string, unknown>)[key];
      return (draft[key] ?? '') !== ((current as string | null) ?? '');
    });
  }, [editing, person, draft]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    nav.setBackGuard(() => {
      if (!dirtyRef.current) return false;
      Alert.alert('Forlad redigering?', 'Dine ændringer bliver ikke gemt.', [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Forlad',
          style: 'destructive',
          onPress: () => {
            dirtyRef.current = false;
            nav.back();
          },
        },
      ]);
      return true;
    });
    return () => nav.setBackGuard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEditing = () => {
    if (!person) return;
    const next: Record<string, string> = {};
    for (const { key } of EDIT_FIELDS) {
      next[key] = ((person as unknown as Record<string, unknown>)[key] as string | null) ?? '';
    }
    setDraft(next);
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!person || saving) return;
    const patch: EditablePersonFields = {};
    for (const { key } of EDIT_FIELDS) {
      const current = ((person as unknown as Record<string, unknown>)[key] as string | null) ?? '';
      const next = (draft[key] ?? '').trim();
      if (next === current) continue;
      if (key === 'name') {
        if (next) patch.name = next; // navnet må ikke tømmes
      } else {
        (patch as Record<string, unknown>)[key] = next || null;
      }
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await updateFields(patch);
      setEditing(false);
    } catch {
      Alert.alert('Gem', 'Ændringerne kunne ikke gemmes. Prøv igen.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (!person) return;
    Alert.alert(
      'Slet person',
      `Slet ${person.name} fra dit netværk? Alle noter, opfølgninger og historik slettes.`,
      [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Slet',
          style: 'destructive',
          onPress: () => {
            void remove().then(() => nav.back());
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <PushHeader title="Person" />
        <View style={{ alignItems: 'center', paddingTop: 80 }}>
          <PapirLoader size={28} />
        </View>
      </View>
    );
  }

  if (!person) {
    return (
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <PushHeader title="Person" />
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 8 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Findes ikke længere
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Denne person er blevet slettet fra dit netværk.
          </PaperText>
        </View>
      </View>
    );
  }

  const workLine = [person.company, person.role].filter(Boolean).join(' · ');
  const openFollowups = bundle!.followups.filter((f) => !f.doneAt);
  const doneFollowups = bundle!.followups.filter((f) => !!f.doneAt);
  const now = Date.now();

  const infoRows: Array<{ label: string; value: string }> = [
    { label: 'Relation', value: person.relation ?? '' },
    { label: 'Branche', value: person.industry ?? '' },
    { label: 'Mødt', value: person.howWeMet ?? '' },
    { label: 'Bor', value: person.location ?? '' },
    { label: 'E-mail', value: person.email ?? '' },
    { label: 'Telefon', value: person.phone ?? '' },
    { label: 'LinkedIn', value: person.linkedin ?? '' },
    {
      label: 'Sidst kontakt',
      value: person.lastContactedAt ? formatShortDate(person.lastContactedAt) : '',
    },
  ].filter((r) => r.value);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
        <PushHeader
          title="Person"
          right={
            editing ? undefined : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <IconButton accessibilityLabel="Redigér" onPress={startEditing}>
                  <PenLine size={15} color={papirColor.ink2} strokeWidth={1.8} />
                </IconButton>
                <IconButton accessibilityLabel="Slet" onPress={confirmDelete}>
                  <Trash2 size={15} color={papirColor.ink2} strokeWidth={1.8} />
                </IconButton>
              </View>
            )
          }
        />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: papirSpace.screen, paddingBottom: 48 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {editing ? (
            <>
              {EDIT_FIELDS.map(({ key, label }) => (
                <View key={key} style={{ marginTop: papirSpace.md }}>
                  <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginBottom: 6 }}>
                    {label}
                  </PaperText>
                  <TextInput
                    value={draft[key] ?? ''}
                    onChangeText={(t) => setDraft((d) => ({ ...d, [key]: t }))}
                    placeholder={label}
                    placeholderTextColor={papirColor.ink4}
                    selectionColor={papirColor.red}
                    multiline={key === 'notes'}
                    style={{
                      borderWidth: 1,
                      borderColor: papirColor.line,
                      borderRadius: papirRadius.md,
                      backgroundColor: papirColor.card,
                      paddingHorizontal: 14,
                      paddingVertical: 11,
                      fontSize: 15,
                      color: papirColor.ink,
                      ...(key === 'notes' ? { minHeight: 90, textAlignVertical: 'top' as const } : {}),
                    }}
                    accessibilityLabel={label}
                  />
                </View>
              ))}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: papirSpace.xl }}>
                <Button
                  label="Annullér"
                  variant="ghost"
                  style={{ flex: 1 }}
                  onPress={() => setEditing(false)}
                />
                <Button
                  label={saving ? 'Gemmer…' : 'Gem'}
                  style={{ flex: 1 }}
                  disabled={saving || !dirty}
                  onPress={() => void saveEdits()}
                />
              </View>
            </>
          ) : (
            <>
              <PaperText role="displayS" style={{ marginTop: 4 }}>
                {person.name}
              </PaperText>
              {workLine ? (
                <PaperText role="body" color={papirColor.ink2} style={{ marginTop: 4 }}>
                  {workLine}
                </PaperText>
              ) : null}

              {person.summary ? (
                <Card style={{ marginTop: papirSpace.lg, backgroundColor: papirColor.paper2, borderColor: papirColor.lineSoft }}>
                  <PaperText role="body" color={papirColor.ink2} style={{ lineHeight: 24 }}>
                    {person.summary}
                  </PaperText>
                </Card>
              ) : null}

              {infoRows.length > 0 ? (
                <>
                  <SectionLabel>Profil</SectionLabel>
                  <Card padded={false} style={{ paddingHorizontal: papirSpace.base }}>
                    {infoRows.map((r, i) => (
                      <View
                        key={r.label}
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          gap: 12,
                          paddingVertical: 12,
                          borderTopWidth: i === 0 ? 0 : 1,
                          borderTopColor: papirColor.lineSoft,
                        }}
                      >
                        <PaperText role="caption" color={papirColor.ink3}>
                          {r.label}
                        </PaperText>
                        <PaperText role="body" style={{ flex: 1, textAlign: 'right' }}>
                          {r.value}
                        </PaperText>
                      </View>
                    ))}
                  </Card>
                </>
              ) : null}

              {person.traits.length > 0 ? (
                <>
                  <SectionLabel>Kendetegn</SectionLabel>
                  <PillRow items={person.traits} />
                </>
              ) : null}

              {person.interests.length > 0 ? (
                <>
                  <SectionLabel>Interesser</SectionLabel>
                  <PillRow items={person.interests} />
                </>
              ) : null}

              {person.projects.length > 0 ? (
                <>
                  <SectionLabel>Projekter</SectionLabel>
                  <PillRow items={person.projects} />
                </>
              ) : null}

              {bundle!.followups.length > 0 ? (
                <>
                  <SectionLabel>Opfølgninger</SectionLabel>
                  <Card padded={false} style={{ paddingHorizontal: papirSpace.base }}>
                    {[...openFollowups, ...doneFollowups].map((f, i) => {
                      const done = !!f.doneAt;
                      const overdue = !done && f.dueAt != null && f.dueAt.getTime() <= now;
                      return (
                        <ScaleButton
                          key={f.id}
                          scaleTo={0.985}
                          haptic="light"
                          onPress={() => void toggleFollowup(f.id, !done)}
                          accessibilityRole="button"
                          accessibilityLabel={done ? `Genåbn: ${f.text}` : `Markér som klaret: ${f.text}`}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                            paddingVertical: 13,
                            borderTopWidth: i === 0 ? 0 : 1,
                            borderTopColor: papirColor.lineSoft,
                          }}
                        >
                          <View
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 11,
                              borderWidth: 1.5,
                              borderColor: done ? papirColor.green : papirColor.ink4,
                              backgroundColor: done ? papirColor.greenSoft : 'transparent',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {done ? <Check size={13} color={papirColor.green} strokeWidth={2.4} /> : null}
                          </View>
                          <View style={{ flex: 1 }}>
                            <PaperText
                              role="body"
                              color={done ? papirColor.ink4 : papirColor.ink}
                              style={done ? { textDecorationLine: 'line-through' } : undefined}
                            >
                              {f.text}
                            </PaperText>
                            {f.dueAt ? (
                              <PaperText
                                role="caption"
                                color={overdue ? papirColor.red : papirColor.ink4}
                                tabular
                                style={{ marginTop: 2 }}
                              >
                                {formatShortDate(f.dueAt)}
                              </PaperText>
                            ) : null}
                          </View>
                        </ScaleButton>
                      );
                    })}
                  </Card>
                </>
              ) : null}

              {person.notes ? (
                <>
                  <SectionLabel>Noter</SectionLabel>
                  <PaperText role="body" color={papirColor.ink} style={{ lineHeight: 24 }}>
                    {person.notes}
                  </PaperText>
                </>
              ) : null}

              {bundle!.interactions.length > 0 ? (
                <>
                  <SectionLabel>Historik</SectionLabel>
                  <View>
                    {bundle!.interactions.map((it) => (
                      <InteractionRow key={it.id} interaction={it} />
                    ))}
                  </View>
                </>
              ) : null}
            </>
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
