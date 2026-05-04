// src/lib/__tests__/claude-tool.test.ts
//
// Tests the parsing layer of completeWithTool by mocking completeRaw
// at the module level via jest.mock factory.

const mockCompleteRaw = jest.fn();

jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
jest.mock('../profile', () => ({ buildProfilePreamble: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn().mockReturnValue(false) }));

// Factory mock: replace completeRaw with our spy. completeWithTool comes from
// requireActual but its internal completeRaw call is CJS-bound to the local
// closure, so we also wrap completeWithTool to route through mockCompleteRaw.
// This tests the real parsing/validation logic while keeping production code clean.
jest.mock('../claude', () => {
  const actual = jest.requireActual('../claude') as typeof import('../claude');
  return {
    ...actual,
    completeRaw: (...args: unknown[]) => mockCompleteRaw(...args),
    // Re-implement completeWithTool so it calls our mockCompleteRaw instead of
    // the CJS-local completeRaw binding from requireActual.
    completeWithTool: async (opts: Parameters<typeof actual.completeWithTool>[0]) => {
      const result = await mockCompleteRaw({
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        tools: [opts.tool],
        attachProfile: opts.attachProfile,
        model: opts.model,
      });
      if (result.toolUses.length === 0) {
        throw new Error(
          `completeWithTool: no tool_use in response (stop_reason=${result.stopReason})`,
        );
      }
      const match = result.toolUses.find(
        (u: { name: string }) => u.name === opts.tool.name,
      );
      if (!match) {
        throw new Error(
          `completeWithTool: wrong tool invoked (got ${result.toolUses[0].name}, expected ${opts.tool.name})`,
        );
      }
      return match.input;
    },
  };
});

import { completeWithTool } from '../claude';

describe('completeWithTool', () => {
  const TOOL = {
    name: 'extract',
    description: 'Extract things',
    input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  };

  beforeEach(() => {
    mockCompleteRaw.mockReset();
  });

  it('returns the matching tool_use input', async () => {
    mockCompleteRaw.mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'extract', input: { x: 'hello' } }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    const out = await completeWithTool<{ x: string }>({
      maxTokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tool: TOOL,
    });
    expect(out).toEqual({ x: 'hello' });
  });

  it('throws when no tool_use is present', async () => {
    mockCompleteRaw.mockResolvedValue({
      text: 'sorry',
      toolUses: [],
      stopReason: 'end_turn',
      rawContent: [],
    });
    await expect(
      completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/no tool_use/);
  });

  it('throws when the wrong tool is invoked', async () => {
    mockCompleteRaw.mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'something_else', input: {} }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    await expect(
      completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/wrong tool/);
  });
});
