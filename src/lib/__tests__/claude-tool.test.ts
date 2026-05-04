// src/lib/__tests__/claude-tool.test.ts
//
// Tests the parsing layer of completeWithTool by mocking completeRaw.

jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
jest.mock('../profile', () => ({ buildProfilePreamble: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn().mockReturnValue(false) }));

import * as claude from '../claude';

describe('completeWithTool', () => {
  const TOOL = {
    name: 'extract',
    description: 'Extract things',
    input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the matching tool_use input', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'extract', input: { x: 'hello' } }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    const out = await claude.completeWithTool<{ x: string }>({
      maxTokens: 100,
      system: 'sys',
      messages: [{ role: 'user', content: 'go' }],
      tool: TOOL,
    });
    expect(out).toEqual({ x: 'hello' });
  });

  it('throws when no tool_use is present', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: 'sorry',
      toolUses: [],
      stopReason: 'end_turn',
      rawContent: [],
    });
    await expect(
      claude.completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/no tool_use/);
  });

  it('throws when the wrong tool is invoked', async () => {
    jest.spyOn(claude, 'completeRaw').mockResolvedValue({
      text: '',
      toolUses: [{ id: 'a', name: 'something_else', input: {} }],
      stopReason: 'tool_use',
      rawContent: [],
    });
    await expect(
      claude.completeWithTool({
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: 'go' }],
        tool: TOOL,
      }),
    ).rejects.toThrow(/wrong tool/);
  });
});
