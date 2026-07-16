// src/lib/network-store.ts
//
// Datalag for Netværk: personer Zolva husker på brugerens vegne, med
// opfølgninger og en interaktions-tidslinje. Samme mønstre som
// profile-store/reminders: rowTo*-mappere, demo-short-circuit på
// DEMO_USER_ID og en changed-listener-bus i stedet for polling.
import { supabase } from './supabase';
import { normalizeFactText } from './profile-store';
import {
  addDemoNetworkFollowup,
  addDemoNetworkInteraction,
  addDemoNetworkPerson,
  deleteDemoNetworkPerson,
  getDemoNetworkFollowups,
  getDemoNetworkInteractions,
  getDemoNetworkPeople,
  isDemoUserId,
  setDemoNetworkFollowupDone,
  setDemoNetworkPersonStatus,
  updateDemoNetworkPerson,
} from './demo-data';

export type NetworkPersonStatus = 'pending' | 'confirmed';

export type NetworkPerson = {
  id: string;
  userId: string;
  name: string;
  normalizedName: string;
  company: string | null;
  role: string | null;
  relation: string | null;
  industry: string | null;
  howWeMet: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  traits: string[];
  interests: string[];
  projects: string[];
  notes: string | null;
  summary: string | null;
  status: NetworkPersonStatus;
  metThroughPersonId: string | null;
  userEditedFields: string[];
  source: string | null;
  lastContactedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NetworkInteractionKind =
  | 'chat'
  | 'voice'
  | 'note'
  | 'meeting'
  | 'mail'
  | 'calendar'
  | 'manual';

export type NetworkFollowup = {
  id: string;
  userId: string;
  personId: string;
  text: string;
  dueAt: Date | null;
  doneAt: Date | null;
  source: string | null;
  createdAt: Date;
};

export type NetworkInteraction = {
  id: string;
  userId: string;
  personId: string;
  kind: NetworkInteractionKind;
  summary: string;
  occurredAt: Date;
  sourceRef: string | null;
};

export type NetworkPersonBundle = {
  person: NetworkPerson;
  followups: NetworkFollowup[];
  interactions: NetworkInteraction[];
};

// AI-udfyldelige felter. Ekstraktoren og save_network_person-toolet leverer
// denne form; mergeAiIntoPerson afgør hvad der faktisk må skrives.
export type AiPersonFields = {
  company?: string | null;
  role?: string | null;
  relation?: string | null;
  industry?: string | null;
  howWeMet?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  traits?: string[];
  interests?: string[];
  projects?: string[];
  summary?: string | null;
};

// Felter brugeren kan redigere i UI'et (og som AI-merge respekterer).
export type EditablePersonFields = AiPersonFields & {
  name?: string;
  notes?: string | null;
};

export const normalizePersonName = normalizeFactText;
export const normalizeCompany = normalizeFactText;

// ─── changed-listener bus ───────────────────────────────────────────────

const networkChangedListeners = new Set<() => void>();

export function subscribeNetworkChanged(listener: () => void): () => void {
  networkChangedListeners.add(listener);
  return () => { networkChangedListeners.delete(listener); };
}

function notifyNetworkChanged(): void {
  for (const fn of networkChangedListeners) {
    try { fn(); } catch { /* én dårlig listener må ikke vælte de andre */ }
  }
}

// ─── mappere ────────────────────────────────────────────────────────────

function jsonArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function rowToPerson(r: Record<string, unknown>): NetworkPerson {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    name: r.name as string,
    normalizedName: r.normalized_name as string,
    company: (r.company as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    relation: (r.relation as string | null) ?? null,
    industry: (r.industry as string | null) ?? null,
    howWeMet: (r.how_we_met as string | null) ?? null,
    location: (r.location as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    linkedin: (r.linkedin as string | null) ?? null,
    traits: jsonArray(r.traits),
    interests: jsonArray(r.interests),
    projects: jsonArray(r.projects),
    notes: (r.notes as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    status: r.status as NetworkPersonStatus,
    metThroughPersonId: (r.met_through_person_id as string | null) ?? null,
    userEditedFields: jsonArray(r.user_edited_fields),
    source: (r.source as string | null) ?? null,
    lastContactedAt: r.last_contacted_at ? new Date(r.last_contacted_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToFollowup(r: Record<string, unknown>): NetworkFollowup {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    personId: r.person_id as string,
    text: r.text as string,
    dueAt: r.due_at ? new Date(r.due_at as string) : null,
    doneAt: r.done_at ? new Date(r.done_at as string) : null,
    source: (r.source as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
  };
}

function rowToInteraction(r: Record<string, unknown>): NetworkInteraction {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    personId: r.person_id as string,
    kind: r.kind as NetworkInteractionKind,
    summary: r.summary as string,
    occurredAt: new Date(r.occurred_at as string),
    sourceRef: (r.source_ref as string | null) ?? null,
  };
}

// Kolonnenavne for AI/bruger-patches (camelCase → snake_case).
const FIELD_COLUMNS: Record<string, string> = {
  name: 'name',
  company: 'company',
  role: 'role',
  relation: 'relation',
  industry: 'industry',
  howWeMet: 'how_we_met',
  location: 'location',
  email: 'email',
  phone: 'phone',
  linkedin: 'linkedin',
  traits: 'traits',
  interests: 'interests',
  projects: 'projects',
  notes: 'notes',
  summary: 'summary',
};

function patchToRow(patch: EditablePersonFields): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const col = FIELD_COLUMNS[key];
    if (!col || value === undefined) continue;
    row[col] = value;
  }
  if (typeof patch.name === 'string') row.normalized_name = normalizePersonName(patch.name);
  if (typeof patch.company === 'string') row.normalized_company = normalizeCompany(patch.company);
  else if (patch.company === null) row.normalized_company = null;
  return row;
}

// ─── læsning ────────────────────────────────────────────────────────────

export async function listNetworkPeople(userId: string): Promise<NetworkPerson[]> {
  if (isDemoUserId(userId)) return getDemoNetworkPeople();
  const { data, error } = await supabase
    .from('network_people')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToPerson);
}

export async function listOpenFollowups(userId: string): Promise<NetworkFollowup[]> {
  if (isDemoUserId(userId)) return getDemoNetworkFollowups().filter((f) => !f.doneAt);
  const { data, error } = await supabase
    .from('network_followups')
    .select('*')
    .eq('user_id', userId)
    .is('done_at', null)
    .order('due_at', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []).map(rowToFollowup);
}

export async function getNetworkPersonBundle(
  userId: string,
  personId: string,
): Promise<NetworkPersonBundle | null> {
  if (isDemoUserId(userId)) {
    const person = getDemoNetworkPeople().find((p) => p.id === personId);
    if (!person) return null;
    return {
      person,
      followups: getDemoNetworkFollowups().filter((f) => f.personId === personId),
      interactions: getDemoNetworkInteractions().filter((i) => i.personId === personId),
    };
  }
  const [personRes, followupsRes, interactionsRes] = await Promise.all([
    supabase.from('network_people').select('*').eq('user_id', userId).eq('id', personId).maybeSingle(),
    supabase
      .from('network_followups')
      .select('*')
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('done_at', { ascending: true, nullsFirst: true })
      .order('due_at', { ascending: true, nullsFirst: false }),
    supabase
      .from('network_interactions')
      .select('*')
      .eq('user_id', userId)
      .eq('person_id', personId)
      .order('occurred_at', { ascending: false })
      .limit(50),
  ]);
  if (personRes.error) throw personRes.error;
  if (!personRes.data) return null;
  if (followupsRes.error) throw followupsRes.error;
  if (interactionsRes.error) throw interactionsRes.error;
  return {
    person: rowToPerson(personRes.data as Record<string, unknown>),
    followups: (followupsRes.data ?? []).map(rowToFollowup),
    interactions: (interactionsRes.data ?? []).map(rowToInteraction),
  };
}

// ─── skrivning ──────────────────────────────────────────────────────────

export async function insertNetworkPerson(
  userId: string,
  input: AiPersonFields & {
    name: string;
    status: NetworkPersonStatus;
    source: string | null;
    notes?: string | null;
  },
): Promise<NetworkPerson> {
  const now = new Date();
  if (isDemoUserId(userId)) {
    const person: NetworkPerson = {
      id: `demo-np-new-${now.getTime()}`,
      userId,
      name: input.name,
      normalizedName: normalizePersonName(input.name),
      company: input.company ?? null,
      role: input.role ?? null,
      relation: input.relation ?? null,
      industry: input.industry ?? null,
      howWeMet: input.howWeMet ?? null,
      location: input.location ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      linkedin: input.linkedin ?? null,
      traits: input.traits ?? [],
      interests: input.interests ?? [],
      projects: input.projects ?? [],
      notes: input.notes ?? null,
      summary: input.summary ?? null,
      status: input.status,
      metThroughPersonId: null,
      userEditedFields: [],
      source: input.source,
      lastContactedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    addDemoNetworkPerson(person);
    notifyNetworkChanged();
    return person;
  }
  const { data, error } = await supabase
    .from('network_people')
    .insert({
      user_id: userId,
      name: input.name,
      normalized_name: normalizePersonName(input.name),
      company: input.company ?? null,
      normalized_company: input.company ? normalizeCompany(input.company) : null,
      role: input.role ?? null,
      relation: input.relation ?? null,
      industry: input.industry ?? null,
      how_we_met: input.howWeMet ?? null,
      location: input.location ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      linkedin: input.linkedin ?? null,
      traits: input.traits ?? [],
      interests: input.interests ?? [],
      projects: input.projects ?? [],
      notes: input.notes ?? null,
      summary: input.summary ?? null,
      status: input.status,
      source: input.source,
      last_contacted_at: now.toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  notifyNetworkChanged();
  return rowToPerson(data as Record<string, unknown>);
}

/**
 * Opdatér felter på en person. Med `byUser: true` (redigering i UI'et)
 * unions patch-nøglerne ind i user_edited_fields, så AI-merge aldrig
 * senere overskriver noget brugeren selv har skrevet.
 */
export async function updateNetworkPersonFields(
  userId: string,
  personId: string,
  patch: EditablePersonFields,
  opts?: { byUser?: boolean; lastContactedAt?: Date },
): Promise<void> {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 0 && !opts?.lastContactedAt) return;
  if (isDemoUserId(userId)) {
    updateDemoNetworkPerson(personId, patch, { byUser: opts?.byUser ?? false });
    notifyNetworkChanged();
    return;
  }
  const row = patchToRow(patch);
  if (opts?.lastContactedAt) row.last_contacted_at = opts.lastContactedAt.toISOString();
  if (opts?.byUser) {
    const { data, error } = await supabase
      .from('network_people')
      .select('user_edited_fields')
      .eq('user_id', userId)
      .eq('id', personId)
      .single();
    if (error) throw error;
    const existing = jsonArray((data as Record<string, unknown>).user_edited_fields);
    row.user_edited_fields = Array.from(new Set([...existing, ...keys]));
  }
  const { error } = await supabase
    .from('network_people')
    .update(row)
    .eq('user_id', userId)
    .eq('id', personId);
  if (error) throw error;
  notifyNetworkChanged();
}

export async function confirmNetworkPerson(userId: string, personId: string): Promise<void> {
  if (isDemoUserId(userId)) {
    setDemoNetworkPersonStatus(personId, 'confirmed');
    notifyNetworkChanged();
    return;
  }
  const { error } = await supabase
    .from('network_people')
    .update({ status: 'confirmed' })
    .eq('user_id', userId)
    .eq('id', personId);
  if (error) throw error;
  notifyNetworkChanged();
}

/** Sletter personen; followups/interaktioner ryger med via FK cascade. */
export async function deleteNetworkPerson(userId: string, personId: string): Promise<void> {
  if (isDemoUserId(userId)) {
    deleteDemoNetworkPerson(personId);
    notifyNetworkChanged();
    return;
  }
  const { error } = await supabase
    .from('network_people')
    .delete()
    .eq('user_id', userId)
    .eq('id', personId);
  if (error) throw error;
  notifyNetworkChanged();
}

export async function addFollowup(
  userId: string,
  personId: string,
  input: { text: string; dueAt: Date | null; source: string | null },
): Promise<NetworkFollowup> {
  if (isDemoUserId(userId)) {
    const followup: NetworkFollowup = {
      id: `demo-nf-new-${Date.now()}`,
      userId,
      personId,
      text: input.text,
      dueAt: input.dueAt,
      doneAt: null,
      source: input.source,
      createdAt: new Date(),
    };
    addDemoNetworkFollowup(followup);
    notifyNetworkChanged();
    return followup;
  }
  const { data, error } = await supabase
    .from('network_followups')
    .insert({
      user_id: userId,
      person_id: personId,
      text: input.text,
      due_at: input.dueAt ? input.dueAt.toISOString() : null,
      source: input.source,
    })
    .select('*')
    .single();
  if (error) throw error;
  notifyNetworkChanged();
  return rowToFollowup(data as Record<string, unknown>);
}

export async function setFollowupDone(
  userId: string,
  followupId: string,
  done: boolean,
): Promise<void> {
  if (isDemoUserId(userId)) {
    setDemoNetworkFollowupDone(followupId, done);
    notifyNetworkChanged();
    return;
  }
  const { error } = await supabase
    .from('network_followups')
    .update({ done_at: done ? new Date().toISOString() : null })
    .eq('user_id', userId)
    .eq('id', followupId);
  if (error) throw error;
  notifyNetworkChanged();
}

/**
 * Log en interaktion. Skipper stille hvis samme source_ref allerede er
 * logget for personen — værn mod dobbelt-logning ved ekstraktor-retries.
 */
export async function addInteraction(
  userId: string,
  personId: string,
  input: {
    kind: NetworkInteractionKind;
    summary: string;
    occurredAt?: Date;
    sourceRef: string | null;
  },
): Promise<void> {
  if (isDemoUserId(userId)) {
    const existing = getDemoNetworkInteractions();
    if (input.sourceRef && existing.some((i) => i.personId === personId && i.sourceRef === input.sourceRef)) return;
    addDemoNetworkInteraction({
      id: `demo-ni-new-${Date.now()}`,
      userId,
      personId,
      kind: input.kind,
      summary: input.summary,
      occurredAt: input.occurredAt ?? new Date(),
      sourceRef: input.sourceRef,
    });
    notifyNetworkChanged();
    return;
  }
  if (input.sourceRef) {
    const { data, error } = await supabase
      .from('network_interactions')
      .select('id')
      .eq('user_id', userId)
      .eq('person_id', personId)
      .eq('source_ref', input.sourceRef)
      .limit(1);
    if (error) throw error;
    if ((data ?? []).length > 0) return;
  }
  const { error } = await supabase.from('network_interactions').insert({
    user_id: userId,
    person_id: personId,
    kind: input.kind,
    summary: input.summary,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    source_ref: input.sourceRef,
  });
  if (error) throw error;
  notifyNetworkChanged();
}

// ─── merge-politik (ren funktion, unit-testbar) ─────────────────────────

const SCALAR_AI_FIELDS = [
  'company', 'role', 'relation', 'industry', 'howWeMet',
  'location', 'email', 'phone', 'linkedin',
] as const;
const ARRAY_AI_FIELDS = ['traits', 'interests', 'projects'] as const;

/**
 * Afgør hvad en AI-ekstraktion må skrive på en eksisterende person:
 * - skalarer udfyldes kun hvis de er tomme OG ikke bruger-redigerede;
 * - arrays appendes med case-insensitiv dedup;
 * - summary må AI altid opdatere (feltet er ikke bruger-redigerbart).
 * Returnerer null når intet ville ændre sig, så kalderen kan springe
 * både UPDATE og interaktions-logning over.
 */
export function mergeAiIntoPerson(
  existing: NetworkPerson,
  extracted: AiPersonFields,
): EditablePersonFields | null {
  const patch: EditablePersonFields = {};
  const locked = new Set(existing.userEditedFields);
  for (const field of SCALAR_AI_FIELDS) {
    const incoming = extracted[field];
    if (typeof incoming !== 'string' || !incoming.trim()) continue;
    if (locked.has(field)) continue;
    const current = existing[field];
    if (current && current.trim()) continue;
    patch[field] = incoming.trim();
  }
  for (const field of ARRAY_AI_FIELDS) {
    const incoming = extracted[field];
    if (!incoming || incoming.length === 0) continue;
    if (locked.has(field)) continue;
    const current = existing[field];
    const seen = new Set(current.map((v) => v.trim().toLowerCase()));
    const fresh = incoming
      .map((v) => v.trim())
      .filter((v) => v && !seen.has(v.toLowerCase()) && (seen.add(v.toLowerCase()), true));
    if (fresh.length > 0) patch[field] = [...current, ...fresh];
  }
  if (
    typeof extracted.summary === 'string' &&
    extracted.summary.trim() &&
    extracted.summary.trim() !== (existing.summary ?? '').trim()
  ) {
    patch.summary = extracted.summary.trim();
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Deterministisk sikkerhedsnet mod dubletter: eksakt match på normaliseret
 * navn — og hvis BEGGE sider kender et firma, skal det også matche (to
 * forskellige "Lars Jensen" fra hver sit firma er to personer).
 */
export function findRosterMatch(
  people: NetworkPerson[],
  name: string,
  company: string | null | undefined,
): NetworkPerson | null {
  const nName = normalizePersonName(name);
  if (!nName) return null;
  const nCompany = company ? normalizeCompany(company) : '';
  for (const p of people) {
    if (p.normalizedName !== nName) continue;
    if (nCompany && p.company && normalizeCompany(p.company) !== nCompany) continue;
    return p;
  }
  return null;
}
