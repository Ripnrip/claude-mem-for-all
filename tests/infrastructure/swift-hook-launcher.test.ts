import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

const canRunSwift = process.platform === 'darwin' && spawnSync('swift', ['--version']).status === 0;

describe('Swift hook launcher', () => {
  test.if(canRunSwift)('dispatches to node with the expected worker args and codex env flag', () => {
    const root = makeTempRoot('claude-mem-swift-launcher-');
    const pluginRoot = join(root, 'plugin');
    const scriptsDir = join(pluginRoot, 'scripts');
    const binDir = join(root, 'bin');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const launcherSrc = join(process.cwd(), 'src', 'swift', 'claude-mem-hook-launcher.swift');
    const argvCapturePath = join(root, 'argv.txt');
    const codexCapturePath = join(root, 'codex.txt');
    const fakeNodePath = join(binDir, 'node');

    writeFileSync(join(scriptsDir, 'bun-runner.js'), '// fake bun runner\n');
    writeFileSync(join(scriptsDir, 'worker-service.cjs'), '// fake worker\n');
    writeFileSync(
      fakeNodePath,
      `#!/bin/sh\nprintf '%s\n' "$CLAUDE_MEM_CODEX_HOOK" > "${codexCapturePath}"\nprintf '%s\n' "$@" > "${argvCapturePath}"\nexit 0\n`
    );
    chmodSync(fakeNodePath, 0o755);

    const result = spawnSync(
      '/usr/bin/swift',
      [launcherSrc, '--plugin-root', pluginRoot, '--codex-hook', '--', 'hook', 'codex', 'context'],
      {
        env: {
          PATH: binDir,
        },
        encoding: 'utf-8',
      }
    );

    expect(result.status).toBe(0);
    expect(readFileSync(codexCapturePath, 'utf-8').trim()).toBe('1');
    const argv = readFileSync(argvCapturePath, 'utf-8').trim().split('\n');
    expect(argv).toEqual([
      join(pluginRoot, 'scripts', 'bun-runner.js'),
      join(pluginRoot, 'scripts', 'worker-service.cjs'),
      'hook',
      'codex',
      'context',
    ]);
  });
});
