// src/lib/icloud-mail.ts
//
// Client for the imap-proxy edge function. Calls validate (during setup)
// and listInbox (during inbox fetch). On auth-failed from listInbox, flips
// the stored credential to 'invalid' state.

import { supabase } from './supabase';
import { loadCredential, markInvalid } from './icloud-credentials';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const PROXY_URL = `${SUPABASE_URL}/functions/v1/imap-proxy`;

export type IcloudMessage = {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  unread: boolean;
  preview: string;
};

export type IcloudErrorCode =
  | 'auth-failed'
  | 'rate-limited'
  | 'protocol'
  | 'temporarily-unavailable'
  | 'network'
  | 'timeout'
  | 'no-credential'
  | 'unauthorized';

export type IcloudResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IcloudErrorCode };

export async function validate(
  email: string,
  password: string,
): Promise<IcloudResult<void>> {
  return await call<void>('validate', { email, password });
}

export async function listInbox(
  userId: string,
  limit = 12,
): Promise<IcloudResult<IcloudMessage[]>> {
  const cred = await loadCredential(userId);
  if (cred.kind !== 'valid') {
    return { ok: false, error: 'no-credential' };
  }
  const res = await call<{ messages: RawMessage[] }>('list-inbox', {
    email: cred.credential.email,
    password: cred.credential.password,
    limit,
  });
  if (!res.ok) {
    if (res.error === 'auth-failed') {
      await markInvalid(userId, 'imap-rejected');
    }
    return res;
  }
  return {
    ok: true,
    data: res.data.messages.map((m) => ({
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      date: new Date(m.date),
      unread: m.unread,
      preview: m.preview,
    })),
  };
}

type RawMessage = {
  uid: number;
  from: string;
  subject: string;
  date: string;
  unread: boolean;
  preview: string;
};

async function call<T>(
  op: 'validate' | 'list-inbox',
  body: Record<string, unknown>,
): Promise<IcloudResult<T>> {
  const session = await supabase.auth.getSession();
  const accessToken = session.data.session?.access_token;
  if (!accessToken) {
    return { ok: false, error: 'unauthorized' };
  }
  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ op, ...body }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  if (res.status === 200) {
    const j = (await res.json()) as { ok: true } & T;
    if (op === 'validate') return { ok: true, data: undefined as T };
    return { ok: true, data: j as T };
  }
  let errCode: IcloudErrorCode;
  try {
    const j = (await res.json()) as { error?: string };
    errCode = (j.error as IcloudErrorCode) ?? 'protocol';
  } catch {
    errCode = 'protocol';
  }
  return { ok: false, error: errCode };
}
