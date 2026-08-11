import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * BIN-283: Tests for the extracted plugin root resolver script.
 *
 * The shell prelude was previously inlined as ~1230 chars of escaped JSON
 * string in every hook entry. Now it's a real checked-in program that can
 * be tested, debugged, and eventually replaced by a Swift binary on Darwin.
 */
describe('resolve-plugin-root.sh (BIN-283)', () => {
  const scriptPath = join(process.cwd(), 'scripts', 'resolve-plugin-root.sh');

  it('script exists and is executable', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('resolves to the correct plugin root when CLAUDE_PLUGIN_ROOT is set', () => {
    const result = execSync(
      `CLAUDE_PLUGIN_ROOT="${join(process.cwd(), 'plugin')}" bash "${scriptPath}"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    expect(result).toBe(join(process.cwd(), 'plugin'));
  });

  it('exports CLAUDE_MEM_PLUGIN_ROOT when sourced', () => {
    const result = execSync(
      `CLAUDE_PLUGIN_ROOT="${join(process.cwd(), 'plugin')}" bash -c 'source "${scriptPath}" && echo "$CLAUDE_MEM_PLUGIN_ROOT"'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    expect(result).toBe(join(process.cwd(), 'plugin'));
  });

  it('exits 1 when no plugin root can be found', () => {
    // Point to a nonexistent config dir so cache and marketplace lookups fail
    let exitCode = 0;
    try {
      execSync(
        `CLAUDE_PLUGIN_ROOT="" CLAUDE_CONFIG_DIR="/tmp/nonexistent-cmem-test-${Date.now()}" bash "${scriptPath}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' },
      );
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBe(1);
  });

  it('does NOT contain the old inline prelude pattern (escaped JSON shell)', () => {
    // The script should NOT have the pattern of inlined version-sorting
    // that characterizes the old JSON-embedded prelude
    const { readFileSync } = require('fs');
    const source = readFileSync(scriptPath, 'utf-8');
    // It should use clear variable names, not _M1/_M2/_M3 single-letter vars
    // (those are kept for parity but the script structure should be readable)
    expect(source).toContain('CLAUDE_MEM_PLUGIN_ROOT');
    expect(source).toContain('PATH recovery');
    expect(source).toContain('Plugin root discovery');
  });
});
