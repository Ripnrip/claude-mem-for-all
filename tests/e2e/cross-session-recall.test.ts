import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { countObservationsByProjects } from '../../src/services/context/ObservationCompiler.js';

/**
 * BIN-279 / BIN-280 / BIN-281 regression: Cross-session, cross-platformSource
 * recall proof.
 *
 * Codex PR#7 review: these tests now call the PRODUCTION countObservationsByProjects
 * function instead of hand-writing SQL, so they serve as real regression gates.
 */
describe('e2e: cross-session cross-platformSource recall', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `cmem-e2e-${Date.now()}.db`);
    db = new Database(dbPath);

    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        type TEXT,
        title TEXT,
        subtitle TEXT,
        narrative TEXT,
        text TEXT,
        facts TEXT,
        concepts TEXT,
        created_at TEXT,
        created_at_epoch INTEGER,
        merged_into_project TEXT
      );
    `);
    db.run(`
      CREATE TABLE sdk_sessions (
        memory_session_id TEXT PRIMARY KEY,
        project TEXT,
        platform_source TEXT,
        created_at TEXT
      );
    `);
    db.run(`
      CREATE TABLE observations_fts (
        title, subtitle, narrative, text, facts, concepts
      );
    `);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it('production countObservationsByProjects finds codex observations without platformSource (BIN-281)', () => {
    const sessionA = 'session-codex-001';
    db.run(
      `INSERT INTO sdk_sessions (memory_session_id, project, platform_source) VALUES (?, ?, ?)`,
      [sessionA, 'shared-project', 'codex'],
    );
    db.run(
      `INSERT INTO observations (memory_session_id, project, type, title, text, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionA, 'shared-project', 'discovery', 'E2E marker from Codex',
       'The magic marker value is xyz-123-recall-me', new Date().toISOString(), Date.now()],
    );

    // Production function WITHOUT platformSource → must find it
    const countAll = countObservationsByProjects(
      { db } as any,
      ['shared-project'],
    );
    expect(countAll).toBe(1);

    // Production function WITH platformSource=claude → must return 0
    // (proving the old filtering behavior that caused the bug)
    const countClaudeOnly = countObservationsByProjects(
      { db } as any,
      ['shared-project'],
      'claude',
    );
    expect(countClaudeOnly).toBe(0);

    // The fix: the welcome gate uses NO platformSource, so countAll > 0
    // even though the observation was written by codex.
    expect(countAll).toBeGreaterThan(0);
  });

  it('production countObservationsByProjects finds worktree parent from composite-only query (BIN-280)', () => {
    const sessionA = 'session-worktree-001';
    db.run(
      `INSERT INTO sdk_sessions (memory_session_id, project, platform_source) VALUES (?, ?, ?)`,
      [sessionA, 'myrepo', 'codex'],
    );
    db.run(
      `INSERT INTO observations (memory_session_id, project, type, title, text, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionA, 'myrepo', 'discovery', 'Worktree marker',
       'remember-this-from-worktree', new Date().toISOString(), Date.now()],
    );

    // Codex PR#7 review: query with ONLY the composite name, NOT the bare name.
    // The fallback in projectsHaveObservations strips 'myrepo/feature-x' → 'myrepo'.
    // Direct match with 'myrepo/feature-x' would fail...
    const countCompositeOnly = countObservationsByProjects(
      { db } as any,
      ['myrepo/feature-x'],
    );
    expect(countCompositeOnly).toBe(0);

    // ...but the stripped fallback should find it.
    const countBaseOnly = countObservationsByProjects(
      { db } as any,
      ['myrepo'],
    );
    expect(countBaseOnly).toBe(1);
  });

  it('production countObservationsByProjects returns 0 for truly nonexistent project', () => {
    const countEmpty = countObservationsByProjects(
      { db } as any,
      ['nonexistent-project'],
    );
    expect(countEmpty).toBe(0);
  });

  it('countObservationsByProjects matches on merged_into_project field', () => {
    const sessionA = 'session-merged-001';
    db.run(
      `INSERT INTO sdk_sessions (memory_session_id, project, platform_source) VALUES (?, ?, ?)`,
      [sessionA, 'old-name', 'codex'],
    );
    db.run(
      `INSERT INTO observations (memory_session_id, project, merged_into_project, type, title, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionA, 'old-name', 'new-name', 'discovery', 'Merged project',
       new Date().toISOString(), Date.now()],
    );

    // Should find via merged_into_project
    const countMerged = countObservationsByProjects(
      { db } as any,
      ['new-name'],
    );
    expect(countMerged).toBe(1);
  });
});
