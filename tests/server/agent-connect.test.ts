import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  agentConnect,
  findOrCreateDefaultProject,
  formatMcpConfig,
  formatCurlExamples,
} from '../../src/server/agent-connect/AgentConnectService.js';
import { verifyServerApiKey } from '../../src/server/auth/sqlite-api-key-service.js';
import { ProjectsRepository } from '../../src/storage/sqlite/projects.js';
import { normalizePlatformSource } from '../../src/shared/platform-source.js';

describe('AgentConnectService', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  describe('findOrCreateDefaultProject', () => {
    it('creates a default project on first call', () => {
      const project = findOrCreateDefaultProject(db);
      expect(project.id).toBeTruthy();
      expect(project.name).toBe('Shared Memory');

      // Verify it's in the database
      const repo = new ProjectsRepository(db);
      const found = repo.getById(project.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Shared Memory');
    });

    it('reuses the existing project on subsequent calls', () => {
      const first = findOrCreateDefaultProject(db);
      const second = findOrCreateDefaultProject(db);
      expect(second.id).toBe(first.id);
    });

    it('respects a custom project name', () => {
      const project = findOrCreateDefaultProject(db, 'Hermes Lab');
      expect(project.name).toBe('Hermes Lab');
    });

    it('does not duplicate when called with the same custom name', () => {
      findOrCreateDefaultProject(db, 'Custom');
      const second = findOrCreateDefaultProject(db, 'Custom');
      const repo = new ProjectsRepository(db);
      expect(repo.list().filter(p => p.name === 'Custom')).toHaveLength(1);
      expect(second.name).toBe('Custom');
    });
  });

  describe('agentConnect', () => {
    it('bootstraps an agent with a valid read+write API key', () => {
      const result = agentConnect(db, { name: 'letta' });

      expect(result.platformSource).toBe('letta');
      expect(result.apiKey).toMatch(/^cmem_/);
      expect(result.projectId).toBeTruthy();
      expect(result.scopes).toContain('memories:read');
      expect(result.scopes).toContain('memories:write');

      // The key must actually verify against the database
      const verified = verifyServerApiKey(db, result.apiKey, ['memories:read', 'memories:write']);
      expect(verified).not.toBeNull();
      expect(verified!.record.projectId).toBe(result.projectId);
    });

    it('preserves agent identity as platform_source', () => {
      const result = agentConnect(db, { name: 'Multica Squad #3' });
      expect(result.platformSource).toBe('multica-squad-3');
    });

    it('creates keys scoped to the project', () => {
      const result = agentConnect(db, { name: 'hermes' });

      const verified = verifyServerApiKey(db, result.apiKey, []);
      expect(verified).not.toBeNull();
      expect(verified!.projectId).toBe(result.projectId);
    });

    it('reuses the same default project across multiple agents', () => {
      const agent1 = agentConnect(db, { name: 'letta' });
      const agent2 = agentConnect(db, { name: 'hermes' });

      expect(agent2.projectId).toBe(agent1.projectId);
      // But they get different keys
      expect(agent2.apiKey).not.toBe(agent1.apiKey);
      expect(agent2.apiKeyId).not.toBe(agent1.apiKeyId);
    });

    it('accepts a custom project name', () => {
      const result = agentConnect(db, { name: 'letta', projectName: 'Mission Control' });
      expect(result.projectName).toBe('Mission Control');
    });

    it('the provisioned key works for write operations (verified by scope check)', () => {
      const result = agentConnect(db, { name: 'codex' });

      // Write scope check
      const writeCheck = verifyServerApiKey(db, result.apiKey, ['memories:write']);
      expect(writeCheck).not.toBeNull();

      // Read scope check
      const readCheck = verifyServerApiKey(db, result.apiKey, ['memories:read']);
      expect(readCheck).not.toBeNull();

      // A scope the key does NOT have should fail
      const adminCheck = verifyServerApiKey(db, result.apiKey, ['admin']);
      expect(adminCheck).toBeNull();
    });

    it('works for any arbitrary agent name — no Claude-only restriction', () => {
      const agents = ['letta', 'hermes', 'multica-squad-7', 'my-custom-bot', 'Cursor', 'Codex'];
      for (const name of agents) {
        const result = agentConnect(db, { name });
        expect(result.apiKey).toMatch(/^cmem_/);
        expect(result.platformSource).toBe(normalizePlatformSource(name));
      }
    });
  });

  describe('formatMcpConfig', () => {
    it('produces a valid MCP server config JSON', () => {
      const result = agentConnect(db, { name: 'letta' });
      const config = formatMcpConfig(result);
      const parsed = JSON.parse(config);

      expect(parsed.mcpServers['claude-mem']).toBeDefined();
      expect(parsed.mcpServers['claude-mem'].env.CLAUDE_MEM_SERVER_API_KEY).toBe(result.apiKey);
      expect(parsed.mcpServers['claude-mem'].env.CLAUDE_MEM_SERVER_PROJECT_ID).toBe(result.projectId);
      expect(parsed.mcpServers['claude-mem'].env.CLAUDE_MEM_ALLOW_ANY_AGENT).toBe('true');
    });
  });

  describe('formatCurlExamples', () => {
    it('includes the API key and project ID in the curl commands', () => {
      const result = agentConnect(db, { name: 'hermes' });
      const curls = formatCurlExamples(result);

      expect(curls).toContain(result.apiKey);
      expect(curls).toContain(result.projectId);
      expect(curls).toContain('/v1/memories');
      expect(curls).toContain('/v1/search');
    });
  });
});
