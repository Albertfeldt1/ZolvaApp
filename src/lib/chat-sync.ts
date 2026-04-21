import AsyncStorage from '@react-native-async-storage/async-storage';
import { upsertChatMessage } from './profile-store';
import type { ChatMessage } from './types';
import { getPrivacyFlag } from './hooks';

const migrationFlagKey = (uid: string) => `zolva.${uid}.chat.synced`;
const chatHistoryKey = (uid: string) => `zolva.${uid}.chat.history`;

// Writes a single chat turn to Supabase. Fire-and-forget; errors are swallowed
// so failures never block the UI. Local AsyncStorage persistence continues
// unchanged.
export function syncChatMessage(userId: string, msg: ChatMessage): void {
  if (!getPrivacyFlag('memory-enabled')) return;
  const role = msg.from === 'user' ? 'user' : 'assistant';
  void upsertChatMessage(userId, { clientId: msg.id, role, content: msg.text }).catch((err) => {
    if (__DEV__) console.warn('[chat-sync] upsert failed:', err);
  });
}

// One-shot migration of existing AsyncStorage chat history to Supabase.
// Called on first toggle-on of memory-enabled. Idempotent via the synced flag.
export async function migrateLocalChatIfNeeded(userId: string): Promise<void> {
  if (!getPrivacyFlag('memory-enabled')) return;
  try {
    const flag = await AsyncStorage.getItem(migrationFlagKey(userId));
    if (flag === '1') return;
    const raw = await AsyncStorage.getItem(chatHistoryKey(userId));
    if (!raw) {
      await AsyncStorage.setItem(migrationFlagKey(userId), '1');
      return;
    }
    const saved = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(saved)) return;
    for (const m of saved) {
      const role = m.from === 'user' ? 'user' : 'assistant';
      await upsertChatMessage(userId, { clientId: m.id, role, content: m.text });
    }
    await AsyncStorage.setItem(migrationFlagKey(userId), '1');
  } catch (err) {
    if (__DEV__) console.warn('[chat-sync] migrate failed:', err);
  }
}
