// src/screens/__tests__/ChatScreen.cap.test.tsx
//
// Behavioural tests for the weekly-chat-cap UX in ChatScreen.
// Strategy: mock every native / heavy module that ChatScreen imports so the
// component tree renders in Jest; then spy on useChat + paywall to exercise
// the three cap scenarios.

// ── Native / Expo module stubs ──────────────────────────────────────────────
jest.mock('expo-glass-effect', () => ({
  GlassView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  return Reanimated;
});
jest.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  Trash2: () => null,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: {} }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'undetermined', canAskAgain: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  addNotificationResponseReceivedListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  getAllScheduledNotificationsAsync: jest.fn().mockResolvedValue([]),
  cancelScheduledNotificationAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
}));

// ── Design / primitive stubs ─────────────────────────────────────────────────
jest.mock('../../design/primitives/GlassFrostedCard', () => ({
  GlassFrostedCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../design/primitives/GlassHaloLayer', () => ({
  GlassHaloLayer: () => null,
}));
jest.mock('../../design/primitives/Icon', () => ({
  Icon: { plus: () => null },
}));
jest.mock('../../design/primitives/Stone', () => ({
  Stone: () => null,
}));
jest.mock('../../lib/liquid-glass', () => ({ liquidGlassReady: false }));

// ── Supabase + async-storage (transitive deps of hooks / auth) ───────────────
jest.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn().mockReturnValue({ data: { subscription: { unsubscribe: jest.fn() } } }),
      signInWithOAuth: jest.fn(),
      signOut: jest.fn(),
    },
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockReturnThis(),
    }),
  },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn().mockResolvedValue(null), setItem: jest.fn(), removeItem: jest.fn(), getAllKeys: jest.fn().mockResolvedValue([]) },
}));

// ── RevenueCat (transitive dep of paywall) ───────────────────────────────────
jest.mock('react-native-purchases', () => ({
  default: { configure: jest.fn(), getCustomerInfo: jest.fn() },
}));
jest.mock('react-native-purchases-ui', () => ({
  default: { presentPaywallIfNeeded: jest.fn(), presentPaywall: jest.fn(), presentCustomerCenter: jest.fn() },
  PAYWALL_RESULT: { PURCHASED: 'PURCHASED', RESTORED: 'RESTORED', NOT_PRESENTED: 'NOT_PRESENTED' },
}));

// ── Secure store (used by auth migration) ────────────────────────────────────
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(null),
  deleteItemAsync: jest.fn().mockResolvedValue(null),
}));

// ── iCloud mail (throws on missing env) ──────────────────────────────────────
jest.mock('../../lib/icloud-mail', () => ({}));
jest.mock('../../lib/chat-tools', () => ({}));

// ── Component dependencies ───────────────────────────────────────────────────
jest.mock('../../components/DrivePickerModal', () => ({
  DrivePickerModal: () => null,
}));
jest.mock('../../components/inline-md', () => ({
  renderInlineMd: (s: string) => s,
}));
jest.mock('../../components/MessageActionMenu', () => ({
  MessageActionMenu: () => null,
}));
jest.mock('../../lib/onboarding-backfill', () => ({
  ingestPickedDriveFiles: jest.fn(),
}));
jest.mock('../../lib/date', () => ({
  formatClock: () => '10:00',
  formatToday: () => ({ dateStr: 'Mandag', dayNum: 7 }),
}));

// ── Paywall (what we spy on) ─────────────────────────────────────────────────
jest.mock('../../lib/paywall');

// ── hooks (what we mock to control chat state) ───────────────────────────────
jest.mock('../../lib/hooks');

// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ChatScreen } from '../ChatScreen';
import * as hooks from '../../lib/hooks';
import * as paywall from '../../lib/paywall';

function mockChat(overrides: Partial<ReturnType<typeof hooks.useChat>>) {
  jest.spyOn(hooks, 'useChat').mockReturnValue({
    data: [],
    typing: false,
    loading: false,
    error: null,
    send: jest.fn(),
    clear: jest.fn(),
    sendDraft: jest.fn(),
    chatCap: null,
    clearChatCap: jest.fn(),
    ...overrides,
  } as ReturnType<typeof hooks.useChat>);
}

// useChatSuggestions is also called in ChatScreen
function setupSuggestions() {
  jest.spyOn(hooks, 'useChatSuggestions').mockReturnValue({
    data: [],
    loading: false,
    error: null,
    waitingMailCount: 0,
  });
}

const onBack = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  setupSuggestions();
});

it('shows the upgrade banner and disables input when capped', async () => {
  mockChat({ chatCap: { resetsAt: new Date(Date.now() + 86_400_000).toISOString() } });
  const { getAllByText, getByLabelText } = await render(<ChatScreen onBack={onBack} />);
  // Two nodes contain "Opgrader til Pro": the description text and the button.
  const matches = getAllByText(/Opgrader til Pro/i);
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(getByLabelText('chat-input').props.editable).toBe(false);
});

it('opens the paywall when the upgrade button is tapped', async () => {
  const spy = jest.spyOn(paywall, 'presentPaywallIfNeeded').mockResolvedValue(false);
  mockChat({ chatCap: { resetsAt: new Date(Date.now() + 86_400_000).toISOString() } });
  const { getAllByText } = await render(<ChatScreen onBack={onBack} />);
  // Press the button — it's the last (shortest) match: "Opgrader til Pro" (no trailing text).
  const buttons = getAllByText(/^Opgrader til Pro$/i);
  fireEvent.press(buttons[0]);
  expect(spy).toHaveBeenCalledWith('pro');
});

it('is not capped when chatCap is null', async () => {
  mockChat({ chatCap: null });
  const { queryByText, getByLabelText } = await render(<ChatScreen onBack={onBack} />);
  expect(queryByText(/Opgrader til Pro/i)).toBeNull();
  expect(getByLabelText('chat-input').props.editable).not.toBe(false);
});

it('calls clearChatCap when presentPaywallIfNeeded resolves true', async () => {
  jest.spyOn(paywall, 'presentPaywallIfNeeded').mockResolvedValue(true);
  const clearChatCap = jest.fn();
  mockChat({
    chatCap: { resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    clearChatCap,
  });
  const { getAllByText } = await render(<ChatScreen onBack={onBack} />);
  const buttons = getAllByText(/^Opgrader til Pro$/i);
  fireEvent.press(buttons[0]);
  // Wait for the promise chain (.then) to flush
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(clearChatCap).toHaveBeenCalledTimes(1);
});
