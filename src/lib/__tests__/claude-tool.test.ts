// src/lib/__tests__/claude-tool.test.ts
//
// Tests parseToolUseResult — the pure parser that completeWithTool
// delegates to. No mocking required.

jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));
jest.mock('../profile', () => ({ buildProfilePreamble: jest.fn() }));
jest.mock('../hooks', () => ({ getPrivacyFlag: jest.fn().mockReturnValue(false) }));

import { parseToolUseResult } from '../claude';

describe('parseToolUseResult', () => {
  it('returns the matching tool_use input', () => {
    const result = {
      text: '',
      toolUses: [{ id: 'a', name: 'extract', input: { x: 'hello' } }],
      stopReason: 'tool_use',
      rawContent: [],
    };
    expect(parseToolUseResult<{ x: string }>(result, 'extract')).toEqual({ x: 'hello' });
  });

  it('throws when no tool_use is present', () => {
    const result = {
      text: 'sorry',
      toolUses: [],
      stopReason: 'end_turn',
      rawContent: [],
    };
    expect(() => parseToolUseResult(result, 'extract')).toThrow(/no tool_use/);
  });

  it('throws when the wrong tool is invoked', () => {
    const result = {
      text: '',
      toolUses: [{ id: 'a', name: 'something_else', input: {} }],
      stopReason: 'tool_use',
      rawContent: [],
    };
    expect(() => parseToolUseResult(result, 'extract')).toThrow(/wrong tool/);
  });
});
