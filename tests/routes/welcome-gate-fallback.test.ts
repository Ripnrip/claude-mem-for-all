import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * BIN-280/281/282: Structural regression tests for the welcome gate fixes.
 *
 * These verify the source code contains the correct patterns. The behavioral
 * tests live in tests/e2e/cross-session-recall.test.ts which calls the actual
 * production countObservationsByProjects function.
 */
describe('Welcome gate source structure (BIN-280, BIN-281, BIN-282)', () => {
  const sourcePath = join(process.cwd(), 'src/services/worker/http/routes/SearchRoutes.ts');

  it('welcome gate uses hasComposites via includes("/") not array length comparison (Codex PR#5 P1)', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain("projects.some(p => p.includes('/'))");
    // Must NOT use the old broken length comparison
    expect(source).not.toContain('baseProjects.length !== projects.length');
  });

  it('welcome gate does NOT pass platformSource to countObservationsByProjects (BIN-281)', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain('countObservationsByProjects(sessionStore, projects)');
    expect(source).not.toContain('countObservationsByProjects(sessionStore, projects, platformSource)');
  });

  it('context inject does NOT forward platformSource to generateContextWithStats (Codex PR#6 P1)', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    // The injectRequest must NOT include platformSource
    expect(source).toContain('Do NOT pass platformSource to context generation');
  });

  it('welcome gate has TTL-bounded negative cache for known-empty projects (Codex PR#4 P2, PR#9 P1)', () => {
    const source = readFileSync(sourcePath, 'utf-8');
    expect(source).toContain('projectsKnownEmpty');
    // Must be a Map with TTL, NOT a permanent Set (Codex PR#9 P1)
    expect(source).toContain('EMPTY_CACHE_TTL_MS');
    expect(source).toContain('Date.now() - emptyAt');
  });
});
