import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * BIN-283: Tests for the extracted plugin root resolver script.
 *
 * The shell prelude was previously inlined as ~1230 chars of escaped JSON
 * string in every hook entry. Now it is a real checked-in program that can
 * be tested, debugged, and eventually replaced by a Swift binary on Darwin.
 */
describe('resolve-plugin-root.sh (BIN-283)', () => {
  const devPath = join(process.cwd(), 'scripts', 'resolve-plugin-root.sh');
  const pluginPath = join(process.cwd(), 'plugin', 'scripts', 'resolve-plugin-root.sh');

  it('script exists in BOTH dev scripts/ and plugin scripts/ (Codex PR#8 P2)', () => {
    expect(existsSync(devPath)).toBe(true);
    expect(existsSync(pluginPath)).toBe(true);
  });

  it('scripts are identical across both locations', () => {
    const dev = readFileSync(devPath, 'utf-8');
    const plugin = readFileSync(pluginPath, 'utf-8');
    expect(dev).toBe(plugin);
  });

  it('resolves to the correct plugin root when CLAUDE_PLUGIN_ROOT is set', () => {
    const result = execSync(
      `CLAUDE_PLUGIN_ROOT="${join(process.cwd(), 'plugin')}" bash "${pluginPath}"`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    expect(result).toBe(join(process.cwd(), 'plugin'));
  });

  it('exports CLAUDE_MEM_PLUGIN_ROOT when sourced', () => {
    const result = execSync(
      `CLAUDE_PLUGIN_ROOT="${join(process.cwd(), 'plugin')}" bash -c 'source "${pluginPath}" && echo "$CLAUDE_MEM_PLUGIN_ROOT"'`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    expect(result).toBe(join(process.cwd(), 'plugin'));
  });

  it('exits 1 when no plugin root can be found', () => {
    let exitCode = 0;
    try {
      execSync(
        `CLAUDE_PLUGIN_ROOT="" CLAUDE_CONFIG_DIR="/tmp/nonexistent-cmem-test-${Date.now()}" bash "${pluginPath}"`,
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' },
      );
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBe(1);
  });
});
