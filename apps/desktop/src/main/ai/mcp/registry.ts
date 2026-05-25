/**
 * MCP Server Registry
 * ====================
 *
 * Defines MCP server configurations for all supported integrations.
 * See apps/desktop/src/main/ai/mcp/registry.ts for the TypeScript implementation.
 *
 * Each server config defines how to connect (stdio or StreamableHTTP),
 * and whether it's enabled by default.
 */

import type { McpServerConfig, McpServerId } from './types';

// =============================================================================
// Server Configuration Definitions
// =============================================================================

/**
 * Context7 MCP server - documentation lookup.
 * Always enabled by default. Uses npx to launch.
 */
const CONTEXT7_SERVER: McpServerConfig = {
  id: 'context7',
  name: 'Context7',
  description: 'Documentation lookup for libraries and frameworks',
  enabledByDefault: true,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp@latest'],
  },
};

/**
 * Linear MCP server - project management.
 * Conditionally enabled when project has Linear integration active.
 * Requires LINEAR_API_KEY environment variable.
 */
function createLinearServer(apiKey?: string): McpServerConfig {
  return {
    id: 'linear',
    name: 'Linear',
    description: 'Project management integration for issues and tasks',
    enabledByDefault: false,
    transport: {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'https://mcp.linear.app/mcp',
        ...(apiKey ? ['--header', 'Authorization: Bearer ${LINEAR_API_KEY}'] : []),
      ],
      env: apiKey ? { LINEAR_API_KEY: apiKey } : undefined,
    },
  };
}

/**
 * Memory MCP server - knowledge graph memory.
 * Conditionally enabled when GRAPHITI_MCP_URL is set.
 * Connects via StreamableHTTP to the running memory sidecar.
 */
function createMemoryServer(url: string): McpServerConfig {
  return {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge graph memory for cross-session insights',
    enabledByDefault: false,
    transport: {
      type: 'streamable-http',
      url,
    },
  };
}

/**
 * Electron MCP server - desktop app automation.
 * Only available to QA agents. Requires ELECTRON_MCP_ENABLED=true.
 * Uses Chrome DevTools Protocol to connect to Electron apps.
 */
const ELECTRON_SERVER: McpServerConfig = {
  id: 'electron',
  name: 'Electron',
  description: 'Desktop app automation via Chrome DevTools Protocol',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'electron-mcp-server'],
  },
};

/**
 * Puppeteer MCP server - web browser automation.
 * Only available to QA agents for non-Electron web frontends.
 */
const PUPPETEER_SERVER: McpServerConfig = {
  id: 'puppeteer',
  name: 'Puppeteer',
  description: 'Web browser automation for frontend validation',
  enabledByDefault: false,
  transport: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic-ai/puppeteer-mcp-server'],
  },
};

// =============================================================================
// Registry
// =============================================================================

/** Options for resolving MCP server configurations */
export interface McpRegistryOptions {
  /** Spec directory for auto-claude MCP server */
  specDir?: string;
  /** Memory MCP server URL (if enabled) */
  memoryMcpUrl?: string;
  /** Linear API key (if available) */
  linearApiKey?: string;
  /** Environment variables for server processes */
  env?: Record<string, string>;
  /** Custom MCP server definitions from project settings */
  customMcpServers?: McpServerConfig[];
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') result[key] = raw;
  }
  return result;
}

function envToken(value: string): string {
  const token = value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return token || 'CUSTOM';
}

function normalizeCustomMcpServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const server = raw as Record<string, unknown>;
  const id = typeof server.id === 'string' ? server.id : null;
  if (!id) return null;

  if (server.transport && typeof server.transport === 'object') {
    return raw as McpServerConfig;
  }

  const name = typeof server.name === 'string' ? server.name : id;
  const description = typeof server.description === 'string' ? server.description : undefined;
  const enabledByDefault = typeof server.enabledByDefault === 'boolean' ? server.enabledByDefault : false;

  if (server.type === 'command' && typeof server.command === 'string') {
    return {
      id,
      name,
      description,
      enabledByDefault,
      transport: {
        type: 'stdio',
        command: server.command,
        args: Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
        env: toStringRecord(server.env),
        cwd: typeof server.cwd === 'string' ? server.cwd : undefined,
      },
    };
  }

  if ((server.type === 'http' || server.type === 'streamable-http') && typeof server.url === 'string') {
    const headerEnv: Record<string, string> = {};
    const headerArgs = Object.entries(toStringRecord(server.headers) ?? {}).flatMap(([header, value]) => {
      const envName = `MCP_${envToken(id)}_${envToken(header)}_HEADER`;
      headerEnv[envName] = value;
      return ['--header', `${header}: \${${envName}}`];
    });

    return {
      id,
      name,
      description,
      enabledByDefault,
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', server.url, ...headerArgs],
        env: Object.keys(headerEnv).length > 0 ? headerEnv : undefined,
      },
    };
  }

  return null;
}

/**
 * Get the MCP server configuration for a given server ID.
 *
 * @param serverId - The server identifier to resolve
 * @param options - Registry options for dynamic server configuration
 * @returns Server configuration or null if not recognized
 */
export function getMcpServerConfig(
  serverId: McpServerId | string,
  options: McpRegistryOptions = {},
): McpServerConfig | null {
  switch (serverId) {
    case 'context7':
      return CONTEXT7_SERVER;

    case 'linear': {
      if (!options.linearApiKey && !options.env?.LINEAR_API_KEY) return null;
      const apiKey = options.linearApiKey ?? options.env?.LINEAR_API_KEY;
      return createLinearServer(apiKey);
    }

    case 'memory': {
      const url = options.memoryMcpUrl ?? options.env?.GRAPHITI_MCP_URL;
      if (!url) return null;
      return createMemoryServer(url);
    }

    case 'electron':
      return ELECTRON_SERVER;

    case 'puppeteer':
      return PUPPETEER_SERVER;

    case 'auto-claude':
      // Auto-Claude tools are registered as in-process AI tools. Keeping this
      // server ID in agent configs preserves user-facing semantics, but there
      // is no external MCP process to launch.
      return null;

    default: {
      const customServer = options.customMcpServers?.find((server) => server.id === serverId);
      return normalizeCustomMcpServer(customServer) ?? null;
    }
  }
}

/**
 * Resolve MCP server configurations for a list of server IDs.
 *
 * Filters out servers that cannot be configured (e.g., missing API keys).
 *
 * @param serverIds - List of server IDs to resolve
 * @param options - Registry options for dynamic server configuration
 * @returns List of resolved server configurations
 */
export function resolveMcpServers(
  serverIds: string[],
  options: McpRegistryOptions = {},
): McpServerConfig[] {
  const configs: McpServerConfig[] = [];

  for (const id of serverIds) {
    const config = getMcpServerConfig(id, options);
    if (config) {
      configs.push(config);
    }
  }

  return configs;
}
