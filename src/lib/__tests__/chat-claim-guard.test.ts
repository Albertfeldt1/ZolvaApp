// Mock supabase + AsyncStorage before importing anything that touches them.
jest.mock('../supabase', () => ({ supabase: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
// claude and hooks import auth.ts which calls supabase.auth at module load —
// mock at the module level so the transitive chain doesn't crash the suite.
jest.mock('../claude', () => ({ completeJson: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn() }));

import {
  buildCorrectionMessage,
  GENERIC_CONFUSED_FALLBACK,
  classifyClaim,
} from '../chat-claim-guard';
import { completeJson } from '../claude';

const mockedCompleteJson = completeJson as jest.MockedFunction<typeof completeJson>;

describe('buildCorrectionMessage', () => {
  it('names the tool when known', () => {
    const out = buildCorrectionMessage('send_mail');
    expect(out).toContain("'send_mail'");
    expect(out).toContain('kaldte ikke værktøjet');
    expect(out).toContain('Påstå aldrig');
  });

  it('falls back to generic phrasing when tool is null', () => {
    const out = buildCorrectionMessage(null);
    expect(out).toContain('et værktøj');
    expect(out).not.toContain("''");
  });
});

describe('GENERIC_CONFUSED_FALLBACK', () => {
  it('is a non-empty Danish sentence', () => {
    expect(GENERIC_CONFUSED_FALLBACK.length).toBeGreaterThan(20);
    expect(GENERIC_CONFUSED_FALLBACK).toMatch(/forvirret|gentage/i);
  });
});

describe('classifyClaim', () => {
  beforeEach(() => {
    mockedCompleteJson.mockReset();
  });

  it('forwards the model verdict for a true claim', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: true,
      tool: 'send_mail',
      reason: 'siger "jeg har sendt"',
    });
    const v = await classifyClaim('Jeg har sendt mailen til Lars.');
    expect(v).toEqual({
      claimed: true,
      tool: 'send_mail',
      reason: 'siger "jeg har sendt"',
    });
  });

  it('returns false for honest non-action text', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: false,
      tool: null,
      reason: 'spørgsmål til brugeren',
    });
    const v = await classifyClaim('Skal jeg sende den nu?');
    expect(v.claimed).toBe(false);
    expect(v.tool).toBeNull();
  });

  it('coerces unknown tool names to null while preserving claimed=true', async () => {
    mockedCompleteJson.mockResolvedValueOnce({
      claimed: true,
      tool: 'totally_made_up_tool',
      reason: 'modellen opfandt et navn',
    });
    const v = await classifyClaim('Jeg har gjort noget uklart.');
    expect(v.claimed).toBe(true);
    expect(v.tool).toBeNull();
  });

  it('passes the supplied AbortSignal through to completeJson', async () => {
    const ctrl = new AbortController();
    mockedCompleteJson.mockResolvedValueOnce({ claimed: false, tool: null, reason: '' });
    await classifyClaim('hej', ctrl.signal);
    expect(mockedCompleteJson).toHaveBeenCalledWith(
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it('disables profile attachment to keep the classifier context clean', async () => {
    mockedCompleteJson.mockResolvedValueOnce({ claimed: false, tool: null, reason: '' });
    await classifyClaim('hej');
    expect(mockedCompleteJson).toHaveBeenCalledWith(
      expect.objectContaining({ attachProfile: false, temperature: 0 }),
    );
  });

  it('fails open when completeJson throws', async () => {
    mockedCompleteJson.mockRejectedValueOnce(new Error('network down'));
    const v = await classifyClaim('Jeg har sendt mailen.');
    expect(v).toEqual({
      claimed: false,
      tool: null,
      reason: 'classifier-failed',
    });
  });

  it('fails open when the response shape is malformed', async () => {
    // claimed missing entirely
    mockedCompleteJson.mockResolvedValueOnce({ tool: 'send_mail' } as any);
    const v = await classifyClaim('Jeg har sendt mailen.');
    expect(v.claimed).toBe(false);
    expect(v.reason).toBe('classifier-failed');
    expect(v.tool).toBeNull();
  });
});
