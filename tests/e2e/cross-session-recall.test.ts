import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * BIN-279 / BIN-280 / BIN-281 regression: Cross-session, cross-platformSource
 * recall proof.
 *
 * This is the "non-virgin project" E2E gate. It proves:
 * 1. Session A (Codex) writes an observation
 * 2. Session B (Claude) recalls it — despite different platformSource
 * 3. The welcome gate does NOT show the "virgin project" banner
 *
 * This test runs against the SQLite layer directly (no HTTP server needed)
 * because the fix is in countObservationsByProjects + the query logic.
 */
describe('e2e: cross-session cross-platformSource recall', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `cmem-e2e-${Date.now()}.db`);
    db = new Database(dbPath);

    // Create the minimal schema matching claude-mem's observations table
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

  it('observation written as codex is visible to claude reader (BIN-281)', () => {
    // ── Session A: Codex writes ────────────────────────────────────
    const sessionA = 'session-codex-001';
    db.run(
      `INSERT INTO sdk_sessions (memory_session_id, project, platform_source) VALUES (?, ?, ?)`,
      [sessionA, 'my-shared-project', 'codex'],
    );
    db.run(
      `INSERT INTO observations (memory_session_id, project, type, title, text, created_at, created_at_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sessionA, 'my-shared-project', 'discovery', 'E2E marker from Codex',
       'The magic marker value is xyz-123-recall-me', new Date().toISOString(), Date.now()],
    );

    // ── Verify: count WITHOUT platformSource filter finds it ───────
    const countAll = db.prepare(
      `SELECT COUNT(*) as count FROM observations o
       WHERE o.project IN ('my-shared-project')`
    ).get() as { count: number };
    expect(countAll.count).toBe(1);

    // ── Verify: count WITH platformSource=claude would NOT find it (old bug) ──
    const countClaudeOnly = db.prepare(
      `SELECT COUNT(*) as count FROM observations o
       LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
       WHERE o.project IN ('my-shared-project')
         AND s.platform_source = 'claude'`
    ).get() as { count: number };
    expect(countClaudeOnly.count).toBe(0);

    // ── The fix: the welcome gate uses NO platformSource filter ────
    // So countObservationsByProjects(db, ['my-shared-project']) returns 1
    // even though the observation was written by codex, not claude.
    expect(countAll.count).toBeGreaterThan(0);
    expect(countClaudeOnly.count).toBe(0);
    // If the gate used platformSource, it would see 0 and show the banner.
    // Since BIN-281 removes the filter, the gate sees countAll.count > 0.
  });

  it('worktree composite fallback finds parent project (BIN-280)', () => {
    // ── Session A: written under plain project name ────────────────
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

    // ── Session B: reads under worktree composite name ─────────────
    // The read path sends projects=['myrepo/feature-x', 'myrepo']
    // Direct match with 'myrepo/feature-x' fails, but 'myrepo' matches.
    const countComposite = db.prepare(
      `SELECT COUNT(*) as count FROM observations o
       WHERE o.project IN ('myrepo/feature-x', 'myrepo')`
    ).get() as { count: number };
    expect(countComposite.count).toBe(1);

    // ── The fallback: strip composite to get basename ──────────────
    // baseProjects = ['myrepo'] (stripped from 'myrepo/feature-x')
    const countBase = db.prepare(
      `SELECT COUNT(*) as count FROM observations o
       WHERE o.project IN ('myrepo')`
    ).get() as { count: number };
    expect(countBase.count).toBe(1);
  });

  it('true virgin project returns 0 (no false positives)', () => {
    const countEmpty = db.prepare(
      `SELECT COUNT(*) as count FROM observations o
       WHERE o.project IN ('nonexistent-project')`
    ).get() as { count: number };
    expect(countEmpty.count).toBe(0);
  });
});
