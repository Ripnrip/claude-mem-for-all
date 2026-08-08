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
  /** Explicit API URL (overrides the derived worker URL). Use when runtime=server. */
  apiUrl?: string;
  /** Use an existing project ID instead of auto-provisioning. */
  existingProjectId?: string;
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
 * Check whether CLAUDE_MEM_AUTO_PROVISION is enabled (default: true).
 * When disabled, `agent connect` will NOT auto-create a project — it will
 * require `--project-id` pointing at an existing project.
 */
function isAutoProvisionEnabled(): boolean {
  const value = process.env.CLAUDE_MEM_AUTO_PROVISION;
  if (value === undefined) return true; // default: enabled
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return true;
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Check whether the runtime is set to 'server' (Postgres backend) rather
 * than the default 'worker' (SQLite backend). When runtime=server, the
 * provisioning path opens the local SQLite worker DB — but the server
 * runtime uses a different backend/port, so the issued key/project won't
 * exist there.
 */
function isServerRuntime(): boolean {
  const runtime = process.env.CLAUDE_MEM_RUNTIME;
  if (runtime === undefined) return false; // default: 'worker'
  return runtime === 'server' || runtime === 'server-beta';
}

/**
 * Find or create a default project for agent connections.
 *
 * When CLAUDE_MEM_AUTO_PROVISION is enabled (the default), a project named
 * "Shared Memory" is created on first call and reused for all subsequent
 * agent connections. This means any agent gets a working project without
 * manual setup.
 *
 * When disabled, this function will look for an existing project but will
 * NOT create one — it throws if no project is found, directing the user to
 * either enable auto-provisioning or pass --project-id.
 */
export function findOrCreateDefaultProject(
  db: Database,
  projectName: string = DEFAULT_PROJECT_NAME,
  rootPath?: string,
  existingProjectId?: string,
): { id: string; name: string } {
  const repo = new ProjectsRepository(db);

  // If a specific project ID was provided, use it directly.
  if (existingProjectId) {
    const byId = repo.getById(existingProjectId);
    if (byId) {
      return { id: byId.id, name: byId.name };
    }
    throw new Error(
      `Project not found: ${existingProjectId}. ` +
      'Create it first or remove --project-id to auto-provision.'
    );
  }

  // Look for an existing project with this name.
  const existing = repo.list().find(p => p.name === projectName);
  if (existing) {
    return { id: existing.id, name: existing.name };
  }

  // No existing project found. If auto-provision is disabled, hard-fail.
  if (!isAutoProvisionEnabled()) {
    const availableProjects = repo.list();
    throw new Error(
      `No project named "${projectName}" found and CLAUDE_MEM_AUTO_PROVISION is disabled. ` +
      (availableProjects.length > 0
        ? `Available projects: ${availableProjects.map(p => `${p.name} (${p.id})`).join(', ')}. `
        : 'No projects exist yet. '
      ) +
      'Either set CLAUDE_MEM_AUTO_PROVISION=true, or pass --project-id <existing-id> to use an existing project.'
    );
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
 *
 * NOTE: This function provisions against the local SQLite worker database.
 * When CLAUDE_MEM_RUNTIME=server, the server uses a separate Postgres
 * backend — call `agentConnect` in worker mode or pass `apiUrl` explicitly
 * to point at the server URL.
 */
export function agentConnect(db: Database, input: AgentConnectInput): AgentConnectResult {
  // Guard: if runtime=server, the local SQLite DB is the wrong backend.
  if (isServerRuntime() && !input.apiUrl) {
    throw new Error(
      'CLAUDE_MEM_RUNTIME=server: agent connect provisions against the local SQLite worker DB, ' +
      'but the server runtime uses a separate Postgres backend. Either:\n' +
      '  1. Run with CLAUDE_MEM_RUNTIME=worker (default) to provision locally, or\n' +
      '  2. Pass --api-url <server-url> to point at the server, or\n' +
      '  3. Use `npx claude-mem server api-key create` against the server backend directly.'
    );
  }

  const platformSource = normalizePlatformSource(input.name);

  // Ensure a default project exists for this agent to write into.
  const projectName = input.projectName ?? DEFAULT_PROJECT_NAME;
  const project = findOrCreateDefaultProject(db, projectName, input.projectRootPath, input.existingProjectId);

  // Provision an API key with full read+write scopes, scoped to the project.
  const created = createServerApiKey(db, {
    name: platformSource + '-agent',
    projectId: project.id,
    scopes: [...DEFAULT_LOCAL_API_KEY_SCOPES],
  });

  const apiUrl = input.apiUrl ?? ('http://127.0.0.1:' + (input.port ?? getWorkerPort()));

  return {
    platformSource,
    apiUrl,
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
 *
 * The MCP server runs over stdio and proxies to the local worker's HTTP API.
 * For server-runtime deployments, the CLAUDE_MEM_SERVER_* env vars point the
 * MCP server at the remote HTTP API instead of the local worker.
 */
export function formatMcpConfig(result: AgentConnectResult): string {
  return JSON.stringify({
    mcpServers: {
      'claude-mem': {
        command: 'npx',
        args: ['claude-mem', 'mcp'],
        env: {
          CLAUDE_MEM_ALLOW_ANY_AGENT: 'true',
          // Point the MCP server at the worker HTTP API that this key was
          // provisioned for. The MCP server proxies tool calls there.
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
