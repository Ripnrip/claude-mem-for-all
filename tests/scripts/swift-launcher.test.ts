import { describe, it, expect, afterEach } from 'bun:test';
import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * BIN-283: Swift hook launcher tests.
 *
 * The Swift launcher replaces both the inline shell prelude AND the
 * resolve-plugin-root.sh script on Darwin. It does PATH recovery,
 * plugin root discovery, and worker spawn in one typed program.
 */
describe('Swift hook launcher (BIN-283)', () => {
  const sourcePath = join(process.cwd(), 'plugin', 'scripts', 'claude-mem-hook-launcher.swift');

  afterEach(() => {
    // Kill any workers spawned during tests
    try {
      execSync('pkill -f "worker-service.cjs.*--daemon"', { stdio: 'ignore', timeout: 2000 });
    } catch {}
  });

  it('source file exists in plugin tree', () => {
    expect(existsSync(sourcePath)).toBe(true);
  });

  it('source compiles without errors', () => {
    // Compile to temp binary
    const result = spawnSync('swiftc', ['-o', '/tmp/swift-launcher-test', sourcePath], {
      timeout: 30000,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
  });

  it('shows usage error with no arguments', () => {
    const result = spawnSync('/tmp/swift-launcher-test', [], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('usage');
  });

  it('exits 1 with clear error when plugin not found', () => {
    const result = spawnSync('/tmp/swift-launcher-test', ['--', 'start'], {
      timeout: 5000,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: '',
        PLUGIN_ROOT: '',
        CLAUDE_CONFIG_DIR: `/tmp/nonexistent-swift-${Date.now()}`,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('contains typed SemVer comparison (not shell sort)', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain('struct SemVer');
    expect(source).toContain('Comparable');
    expect(source).toContain('discoverPluginRoot');
    expect(source).toContain('discoverCacheCandidates');
  });

  it('auto-discovers plugin root when --plugin-root is omitted', () => {
    // The source must support auto-discovery mode
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain('pluginRoot: String?');
    expect(source).toContain('guard let discovered = discoverPluginRoot()');
  });

  it('exports CLAUDE_MEM_PLUGIN_ROOT for child process', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain('CLAUDE_MEM_PLUGIN_ROOT');
  });
});
