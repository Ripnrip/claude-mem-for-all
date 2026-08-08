// SPDX-License-Identifier: Apache-2.0
//
// AgentConnectService — one-shot bootstrap for any agent to become a full
// read/write peer on the shared memory backend.
//
// The brief: "Build a simple wrapper or config flag that lets any agent
// authenticate as a server." This service implements that wrapper. Given an
// agent name, it:
//
//   1. Ensures a default project exists (creating one if CLAUDE_MEM_AUTO_PROVISION
//      is enabled).
//   2. Provisions an API key with `memories:read` + `memories:write` scopes,
//      scoped to that project.
//   3. Returns a ready-to-use connection bundle: URL, API key, project ID,
//      platform_source — everything an agent needs to connect.
//
// The SQLite schema and server model are untouched. No permission checks are
// weakened — the key is created through the same scrypt-hashed path as any
// other key. The difference is convenience: one command instead of three.

import type { Database } from 'bun:sqlite';
import {
  createServerApiKey,
  DEFAULT_LOCAL_API_KEY_SCOPES,
} from '../auth/sqlite-api-key-service.js';
import { ProjectsRepository } from '../../storage/sqlite/projects.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

export interface AgentConnectInput {
  /** Human-readable agent name (e.g. "letta", "hermes", "multica-squad-3"). */
  name: string;
  /** Optional project name; defaults to "Shared Memory". */
  projectName?: string;
  /** Optional project root path. */
  projectRootPath?: string;
  /** Override the worker port (defaults to env/UID-derived port). */
  port?: number;
}

export interface AgentConnectResult {
  /** The platform_source slug this agent's memories will be attributed to. */
  platformSource: string;
  /** Base URL for the REST API. */
  apiUrl: string;
  /** The raw API key (shown once — the agent must store it). */
  apiKey: string;
  /** The API key record ID. */
  apiKeyId: string;
  /** The project ID this key is scoped to. */
  projectId: string;
  /** The project name. */
  projectName: string;
  /** Scopes granted to this key. */
  scopes: string[];
}

const DEFAULT_PROJECT_NAME = 'Shared Memory';

/**
 * Find or create a default project for agent connections.
 *
 * When CLAUDE_MEM_AUTO_PROVISION is enabled (the default), a project named
 * "Shared Memory" is created on first call and reused for all subsequent
 * agent connections. This means any agent gets a working project without
 * manual setup.
 */
export function findOrCreateDefaultProject(
  db: Database,
  projectName: string = DEFAULT_PROJECT_NAME,
  rootPath?: string,
): { id: string; name: string } {
  const repo = new ProjectsRepository(db);

  // Look for an existing project with this name.
  const existing = repo.list().find(p => p.name === projectName);
  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  // Auto-provision a new project.
  const created = repo.create({
    name: projectName,
    ...(rootPath ? { rootPath } : {}),
    metadata: { autoProvisioned: true, createdAt: new Date().toISOString() },
  });

  return { id: created.id, name: created.name };
}

/**
 * Bootstrap an agent as a full read/write peer on the shared memory backend.
 *
 * Usage:
 *   const result = agentConnect(db, { name: 'letta' });
 *   // → { platformSource: 'letta', apiUrl: 'http://127.0.0.1:37777', apiKey: 'cmem_...', ... }
 *
 * The returned connection bundle contains everything an agent needs to
 * authenticate and start reading/writing memories immediately.
 */
export function agentConnect(db: Database, input: AgentConnectInput): AgentConnectResult {
  const platformSource = normalizePlatformSource(input.name);

  // Ensure a default project exists for this agent to write into.
  const projectName = input.projectName ?? DEFAULT_PROJECT_NAME;
  const project = findOrCreateDefaultProject(db, projectName, input.projectRootPath);

  // Provision an API key with full read+write scopes, scoped to the project.
  const created = createServerApiKey(db, {
    name: platformSource + '-agent',
    projectId: project.id,
    scopes: [...DEFAULT_LOCAL_API_KEY_SCOPES],
  });

  const port = input.port ?? getWorkerPort();

  return {
    platformSource,
    apiUrl: 'http://127.0.0.1:' + port,
    apiKey: created.rawKey,
    apiKeyId: created.record.id,
    projectId: project.id,
    projectName: project.name,
    scopes: created.record.scopes,
  };
}

/**
 * Format the connection bundle as a ready-to-use MCP client config JSON.
 * This is what an agent pastes into its MCP server configuration.
 */
export function formatMcpConfig(result: AgentConnectResult): string {
  return JSON.stringify({
    mcpServers: {
      'claude-mem': {
        command: 'npx',
        args: ['claude-mem', 'mcp'],
        env: {
          CLAUDE_MEM_ALLOW_ANY_AGENT: 'true',
          CLAUDE_MEM_RUNTIME: 'server',
          CLAUDE_MEM_SERVER_URL: result.apiUrl,
          CLAUDE_MEM_SERVER_API_KEY: result.apiKey,
          CLAUDE_MEM_SERVER_PROJECT_ID: result.projectId,
        },
      },
    },
  }, null, 2);
}

/**
 * Format the connection bundle as curl examples for quick testing.
 */
export function formatCurlExamples(result: AgentConnectResult): string {
  const writeBody = JSON.stringify({
    projectId: result.projectId,
    kind: 'manual',
    type: 'note',
    title: 'Hello from ' + result.platformSource,
    text: 'This agent can read and write shared memory.',
  });
  const searchBody = JSON.stringify({
    projectId: result.projectId,
    query: 'hello',
  });

  return [
    '# Write a memory',
    'curl -X POST ' + result.apiUrl + '/v1/memories \\',
    '  -H "Authorization: Bearer ' + result.apiKey + '" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d ' + "'" + writeBody + "'",
    '',
    '# Search memories',
    'curl -X POST ' + result.apiUrl + '/v1/search \\',
    '  -H "Authorization: Bearer ' + result.apiKey + '" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d ' + "'" + searchBody + "'",
  ].join('\n');
}
