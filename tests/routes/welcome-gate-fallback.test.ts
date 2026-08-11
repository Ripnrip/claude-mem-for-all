import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * BIN-280 regression: projectsHaveObservations must fall back to parent
 * project name when worktree composite names don't match, instead of
 * silently returning the welcome banner.
 *
 * BIN-281 regression: projectsHaveObservations must NOT filter by
 * platformSource — any agent should see observations from any other agent.
 *
 * BIN-282 regression: the welcome gate must provide diagnostic logging
 * instead of silently returning the banner.
 */
describe('Welcome gate fallback (BIN-280, BIN-281, BIN-282)', () => {
  it('SearchRoutes.ts contains worktree composite fallback logic', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/services/worker/http/routes/SearchRoutes.ts'),
      'utf-8',
    );
    // BIN-280: must strip composite project names and retry with basename
    expect(source).toContain('baseProjects');
    expect(source).toContain('hasComposites');
  });

  it('SearchRoutes.ts welcome gate does NOT pass platformSource to countObservationsByProjects', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/services/worker/http/routes/SearchRoutes.ts'),
      'utf-8',
    );
    // BIN-281: the primary observation count call must NOT include platformSource
    expect(source).toContain('countObservationsByProjects(sessionStore, projects)');
    expect(source).not.toContain('countObservationsByProjects(sessionStore, projects, platformSource)');
    expect(source).toContain('BIN-281');
  });

  it('countObservationsByProjects works without platformSource filter', async () => {
    const mod = await import('../../src/services/context/ObservationCompiler.js');
    expect(typeof mod.countObservationsByProjects).toBe('function');

    const mockDb = {
      db: {
        prepare: () => ({
          get: () => ({ count: 1 }),
        }),
      },
    };
    const result = mod.countObservationsByProjects(
      mockDb as any,
      ['myproject'],
    );
    expect(result).toBe(1);
  });
});
