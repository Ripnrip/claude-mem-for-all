import { describe, it, expect } from 'bun:test';
import { cursorAdapter } from '../../src/cli/adapters/cursor.js';

describe('cursor adapter formatOutput', () => {
  it('passes through hookSpecificOutput (SessionStart context injection)', () => {
    const result = {
      continue: true as const,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Previous observations:\n- User prefers dark mode',
      },
    };

    const output = cursorAdapter.formatOutput(result) as Record<string, unknown>;

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeDefined();
    const hookOutput = output.hookSpecificOutput as Record<string, unknown>;
    expect(hookOutput.hookEventName).toBe('SessionStart');
    expect(hookOutput.additionalContext).toContain('dark mode');
  });

  it('passes through systemMessage', () => {
    const result = {
      continue: true as const,
      systemMessage: 'Memory context loaded',
    };

    const output = cursorAdapter.formatOutput(result) as Record<string, unknown>;

    expect(output.systemMessage).toBe('Memory context loaded');
  });

  it('passes through suppressOutput', () => {
    const result = {
      continue: true as const,
      suppressOutput: true,
    };

    const output = cursorAdapter.formatOutput(result) as Record<string, unknown>;

    expect(output.suppressOutput).toBe(true);
  });

  it('does not include hookSpecificOutput when not provided', () => {
    const result = { continue: true as const };

    const output = cursorAdapter.formatOutput(result) as Record<string, unknown>;

    expect(output.continue).toBe(true);
    expect(output.hookSpecificOutput).toBeUndefined();
    expect(output.systemMessage).toBeUndefined();
  });

  it('defaults continue to true when not specified', () => {
    const result = {} as any;

    const output = cursorAdapter.formatOutput(result) as Record<string, unknown>;

    expect(output.continue).toBe(true);
  });
});
