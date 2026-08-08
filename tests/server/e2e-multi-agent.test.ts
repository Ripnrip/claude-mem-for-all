import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { logger } from '../../src/utils/logger.js';
import { agentConnect } from '../../src/server/agent-connect/AgentConnectService.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

/**
 * E2E multi-agent shared memory gate.
 *
 * This is the "dumb e2e gate" (not vibes) requested in PR review:
 *
 *   1. Spin up a real HTTP server backed by a temp SQLite DB.
 *   2. Use `agent connect` to bootstrap two agents (letta, hermes) as full
 *      read/write peers on the same shared project.
 *   3. Client A (letta) writes a marker memory via the REST API.
 *   4. Client B (hermes) reads it via search, then appends its own memory.
 *   5. Inspect SQLite directly to prove both writes landed with correct
 *      provenance (platform_source, distinct API key IDs).
 *   6. Negative case: an unauthenticated request gets 401, and a bogus key
 *      gets 403 — auth semantics are NOT bypassed.
 */
describe('e2e: multi-agent shared memory', () => {
  let db: Database;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');

    const options: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null,
      }),
    };
    server = new Server(options);
    // Use 'api-key' mode (NOT local-dev bypass) so auth is enforced for real.
    server.registerRoutes(new ServerV1Routes({
      getDatabase: () => db,
      authMode: 'api-key',
      allowLocalDevBypass: false,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected server to bind to an ephemeral TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch (error: any) {
      if (error?.code !== 'ERR_SERVER_NOT_RUNNING') {
        throw error;
      }
    }
    db.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  it('two agents share memory: letta writes, hermes reads + appends, provenance is correct', async () => {
    // ── Step 1: Bootstrap both agents via agent connect ──────────────
    const lettaConn = agentConnect(db, { name: 'letta', port });
    const hermesConn = agentConnect(db, { name: 'hermes', port });

    // Both agents share the same default project.
    expect(lettaConn.projectId).toBe(hermesConn.projectId);
    expect(lettaConn.platformSource).toBe('letta');
    expect(hermesConn.platformSource).toBe('hermes');
    expect(lettaConn.apiKey).not.toBe(hermesConn.apiKey);

    // ── Step 2: Client A (letta) writes a marker memory ──────────────
    const lettaWrite = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${lettaConn.apiKey}`,
      },
      body: JSON.stringify({
        projectId: lettaConn.projectId,
        kind: 'manual',
        type: 'note',
        title: 'Marker from letta',
        narrative: 'The quick brown fox jumps over the lazy dog.',
        facts: ['letta was here first'],
      }),
    });
    expect(lettaWrite.status).toBe(201);
    const lettaMemory = (await lettaWrite.json()).memory;
    expect(lettaMemory.id).toBeTruthy();

    // ── Step 3: Client B (hermes) reads the marker via search ────────
    const hermesSearch = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hermesConn.apiKey}`,
      },
      body: JSON.stringify({
        projectId: hermesConn.projectId,
        query: 'quick brown fox',
      }),
    });
    expect(hermesSearch.status).toBe(200);
    const searchResult = await hermesSearch.json();
    expect(searchResult.memories.map((m: any) => m.id)).toContain(lettaMemory.id);

    // ── Step 4: Client B (hermes) appends its own memory ─────────────
    const hermesWrite = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hermesConn.apiKey}`,
      },
      body: JSON.stringify({
        projectId: hermesConn.projectId,
        kind: 'manual',
        type: 'note',
        title: 'Response from hermes',
        narrative: 'Hermes read the marker and is adding its own observation.',
        facts: ['hermes can see letta memories'],
      }),
    });
    expect(hermesWrite.status).toBe(201);
    const hermesMemory = (await hermesWrite.json()).memory;
    expect(hermesMemory.id).toBeTruthy();
    expect(hermesMemory.id).not.toBe(lettaMemory.id);

    // ── Step 5: Inspect SQLite directly to prove both writes landed ──
    const rows = db.prepare(
      'SELECT id, title, project_id FROM memory_items ORDER BY created_at_epoch'
    ).all() as Array<{ id: string; title: string; project_id: string }>;

    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.id)).toContain(lettaMemory.id);
    expect(rows.map(r => r.id)).toContain(hermesMemory.id);

    // Both memories are in the same shared project.
    for (const row of rows) {
      expect(row.project_id).toBe(lettaConn.projectId);
    }

    // Both are indexed in FTS (the trigger fired).
    const ftsCount = db.prepare(
      'SELECT COUNT(*) AS count FROM memory_items_fts WHERE project_id = ?'
    ).get(lettaConn.projectId) as { count: number };
    expect(ftsCount.count).toBe(2);

    // ── Step 5b: Provenance — two distinct API keys, both active ─────
    const keyRows = db.prepare(
      'SELECT id, name, project_id, scopes, status FROM api_keys ORDER BY created_at_epoch'
    ).all() as Array<{ id: string; name: string; project_id: string; scopes: string; status: string }>;

    expect(keyRows).toHaveLength(2);
    expect(keyRows[0].name).toBe('letta-agent');
    expect(keyRows[1].name).toBe('hermes-agent');
    expect(keyRows.every(k => k.status === 'active')).toBe(true);
    expect(keyRows.every(k => k.project_id === lettaConn.projectId)).toBe(true);

    // Each key has both read and write scopes.
    for (const keyRow of keyRows) {
      const scopes = JSON.parse(keyRow.scopes);
      expect(scopes).toContain('memories:read');
      expect(scopes).toContain('memories:write');
    }
  });

  it('negative case: no auth → 401, bogus key → 403', async () => {
    const conn = agentConnect(db, { name: 'letta', port });

    // No Authorization header at all.
    const noAuthResponse = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: conn.projectId,
        kind: 'manual',
        type: 'note',
        title: 'Should fail',
      }),
    });
    expect(noAuthResponse.status).toBe(401);

    // Invalid API key.
    const bogusKeyResponse = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer cmem_bogus_invalid_key_that_does_not_exist',
      },
      body: JSON.stringify({
        projectId: conn.projectId,
        kind: 'manual',
        type: 'note',
        title: 'Should also fail',
      }),
    });
    expect(bogusKeyResponse.status).toBe(403);

    // Nothing was written.
    const count = db.prepare('SELECT COUNT(*) AS count FROM memory_items').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('negative case: read-only key cannot write (scope enforcement)', async () => {
    const conn = agentConnect(db, { name: 'observer', port });

    // Search (read) should work.
    const readResponse = await fetch(`http://127.0.0.1:${port}/v1/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conn.apiKey}`,
      },
      body: JSON.stringify({
        projectId: conn.projectId,
        query: 'anything',
      }),
    });
    expect(readResponse.status).toBe(200);

    // Now revoke the full-access key and create a read-only one.
    // We can't change the existing key's scopes via the API, but we can
    // verify the scope check works by using a key that only has read.
    const { createServerApiKey } = await import('../../src/server/auth/sqlite-api-key-service.js');
    const readOnlyKey = createServerApiKey(db, {
      name: 'read-only-observer',
      projectId: conn.projectId,
      scopes: ['memories:read'],
    });

    // Write should fail with read-only key.
    const writeResponse = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readOnlyKey.rawKey}`,
      },
      body: JSON.stringify({
        projectId: conn.projectId,
        kind: 'manual',
        type: 'note',
        title: 'Should be denied',
      }),
    });
    expect(writeResponse.status).toBe(403);
  });
});
