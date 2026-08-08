import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression tests for the Codex hook fixes (BIN-253, BIN-254, BIN-255).
 *
 * BIN-253: The version-check.js gate must NOT be in the SessionStart
 * critical path. Previously, a stale .install-version marker caused
 * version-check to emit an upgrade hint to stdout and exit(0),
 * suppressing the real context hook entirely.
 *
 * BIN-254: Codex SessionStart must have a dedicated worker start hook
 * (like Claude Code), not just a context hook that lazy-spawns.
 *
 * These tests validate the hook JSON structure directly, because the
 * actual hook execution requires a full Codex runtime environment.
 */
describe('codex-hooks.json structure (BIN-253/254 regression)', () => {
  const hooksPath = join(process.cwd(), 'plugin', 'hooks', 'codex-hooks.json');
  const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));

  describe('SessionStart hooks', () => {
    const sessionStartHooks = hooks.hooks?.SessionStart?.[0]?.hooks ?? [];

    it('has at least 2 hooks (worker start + context)', () => {
      expect(sessionStartHooks.length).toBeGreaterThanOrEqual(2);
    });

    it('first hook bootstraps the worker (BIN-254)', () => {
      const startCommand = sessionStartHooks[0]?.command ?? '';
      // The first hook must be a worker start command, not a context hook.
      // It should contain 'start' as the worker-service argument.
      expect(startCommand).toContain('start');
      // It must NOT be a context hook (those contain 'hook ... context').
      expect(startCommand).not.toMatch(/hook\s+codex\s+context/);
    });

    it('second hook injects context (the real memory hook)', () => {
      const contextCommand = sessionStartHooks[1]?.command ?? '';
      expect(contextCommand).toContain('hook');
      expect(contextCommand).toContain('codex');
      expect(contextCommand).toContain('context');
    });

    it('does NOT gate SessionStart behind version-check.js (BIN-253)', () => {
      // The old command ran version-check.js FIRST and suppressed the real
      // hook if it produced any output. None of the SessionStart hook
      // commands should contain the version-check gate.
      for (const hook of sessionStartHooks) {
        const cmd = hook.command ?? '';
        // The version-check gate pattern: running version-check.js and
        // branching on its output to decide whether to run the real hook.
        expect(cmd).not.toContain('version-check.js');
      }
    });

    it('Windows commands also do not gate on version-check.js', () => {
      for (const hook of sessionStartHooks) {
        const winCmd = hook.commandWindows ?? '';
        expect(winCmd).not.toContain('version-check.js');
      }
    });
  });

  describe('all hooks use codex platform (not claude-code)', () => {
    it('UserPromptSubmit uses hook codex session-init', () => {
      const cmd = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? '';
      expect(cmd).toContain('hook codex session-init');
    });

    it('PostToolUse uses hook codex observation', () => {
      const cmd = hooks.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command ?? '';
      expect(cmd).toContain('hook codex observation');
    });

    it('Stop uses hook codex summarize', () => {
      const cmd = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? '';
      expect(cmd).toContain('hook codex summarize');
    });
  });
});
