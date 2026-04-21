import { supabase } from './supabase';
import type {
  ChatMessageRow,
  Fact,
  FactCategory,
  FactStatus,
  MailEvent,
  MailEventType,
} from './types';

export function normalizeFactText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToFact(r: Record<string, unknown>): Fact {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    text: r.text as string,
    normalizedText: r.normalized_text as string,
    category: r.category as FactCategory,
    status: r.status as FactStatus,
    source: (r.source as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at as string) : null,
    rejectedAt: r.rejected_at ? new Date(r.rejected_at as string) : null,
    rejectionTtl: r.rejection_ttl ? new Date(r.rejection_ttl as string) : null,
  };
}

function rowToMailEvent(r: Record<string, unknown>): MailEvent {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    eventType: r.event_type as MailEventType,
    providerThreadId: r.provider_thread_id as string,
    providerFrom: (r.provider_from as string | null) ?? null,
    providerSubject: (r.provider_subject as string | null) ?? null,
    occurredAt: new Date(r.occurred_at as string),
  };
}

function rowToChatMessage(r: Record<string, unknown>): ChatMessageRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    clientId: r.client_id as string,
    role: r.role as 'user' | 'assistant' | 'tool',
    content: r.content as string,
    createdAt: new Date(r.created_at as string),
  };
}

export async function listFacts(userId: string, status?: FactStatus): Promise<Fact[]> {
  let q = supabase.from('facts').select('*').eq('user_id', userId).order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(rowToFact);
}

export async function findDuplicateFact(
  userId: string,
  normalizedText: string,
): Promise<Fact | null> {
  const { data, error } = await supabase
    .from('facts')
    .select('*')
    .eq('user_id', userId)
    .eq('normalized_text', normalizedText)
    .or('status.eq.confirmed,and(status.eq.rejected,rejection_ttl.gt.' + new Date().toISOString() + ')')
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? rowToFact(row) : null;
}

export async function insertPendingFact(
  userId: string,
  input: { text: string; category: FactCategory; source: string | null },
): Promise<Fact> {
  const normalized = normalizeFactText(input.text);
  const { data, error } = await supabase
    .from('facts')
    .insert({
      user_id: userId,
      text: input.text,
      normalized_text: normalized,
      category: input.category,
      status: 'pending',
      source: input.source,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToFact(data as Record<string, unknown>);
}

export async function confirmFact(factId: string): Promise<void> {
  const { error } = await supabase
    .from('facts')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', factId);
  if (error) throw error;
}

export async function rejectFact(factId: string): Promise<void> {
  const ttl = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('facts')
    .update({ status: 'rejected', rejected_at: new Date().toISOString(), rejection_ttl: ttl })
    .eq('id', factId);
  if (error) throw error;
}

export async function deleteFact(factId: string): Promise<void> {
  const { error } = await supabase.from('facts').delete().eq('id', factId);
  if (error) throw error;
}

export async function deleteAllFacts(userId: string): Promise<void> {
  const { error } = await supabase.from('facts').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function listRecentMailEvents(userId: string, limit = 5): Promise<MailEvent[]> {
  const { data, error } = await supabase
    .from('mail_events')
    .select('*')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToMailEvent);
}

export async function insertMailEvent(
  userId: string,
  ev: Omit<MailEvent, 'id' | 'userId' | 'occurredAt'>,
): Promise<void> {
  const { error } = await supabase.from('mail_events').insert({
    user_id: userId,
    event_type: ev.eventType,
    provider_thread_id: ev.providerThreadId,
    provider_from: ev.providerFrom,
    provider_subject: ev.providerSubject,
  });
  if (error) throw error;
}

export async function upsertChatMessage(
  userId: string,
  row: Pick<ChatMessageRow, 'clientId' | 'role' | 'content'>,
): Promise<void> {
  const { error } = await supabase.from('chat_messages').upsert(
    {
      user_id: userId,
      client_id: row.clientId,
      role: row.role,
      content: row.content,
    },
    { onConflict: 'user_id,client_id' },
  );
  if (error) throw error;
}

export async function listRecentChatMessages(
  userId: string,
  limit = 3,
): Promise<ChatMessageRow[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToChatMessage).reverse();
}

export async function deleteAllChatHistory(userId: string): Promise<void> {
  const { error } = await supabase.from('chat_messages').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function deleteAllMailEvents(userId: string): Promise<void> {
  const { error } = await supabase.from('mail_events').delete().eq('user_id', userId);
  if (error) throw error;
}

export async function getFactsSignature(userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('facts')
    .select('id, created_at, confirmed_at, rejected_at')
    .eq('user_id', userId);
  if (error) throw error;
  const rows = data ?? [];
  const latest = rows.reduce<number>((acc, r) => {
    const parse = (v: unknown): number => {
      if (typeof v !== 'string' || v.length === 0) return 0;
      const n = Date.parse(v);
      return Number.isFinite(n) ? n : 0;
    };
    const t = Math.max(
      parse(r.created_at),
      parse(r.confirmed_at),
      parse(r.rejected_at),
    );
    return Math.max(acc, t);
  }, 0);
  return `${rows.length}:${latest}`;
}
