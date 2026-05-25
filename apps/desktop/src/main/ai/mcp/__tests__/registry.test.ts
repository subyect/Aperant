/**
 * Tests for MCP Server Registry
 *
 * Validates server configuration resolution, required server lookup,
 * and option-based server filtering.
 */

import { describe, expect, it } from 'vitest';
import { getMcpServerConfig, resolveMcpServers } from '../registry';

// =============================================================================
// getMcpServerConfig
// =============================================================================

describe('getMcpServerConfig', () => {
  describe('context7', () => {
    it('returns the context7 server config', () => {
      const config = getMcpServerConfig('context7');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('context7');
      expect(config?.enabledByDefault).toBe(true);
    });

    it('uses stdio transport with npx', () => {
      const config = getMcpServerConfig('context7');
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.command).toBe('npx');
      }
    });
  });

  describe('linear', () => {
    it('returns null when no API key provided', () => {
      const config = getMcpServerConfig('linear', {});
      expect(config).toBeNull();
    });

    it('returns config when linearApiKey is provided', () => {
      const config = getMcpServerConfig('linear', { linearApiKey: 'lin_api_123' });
      expect(config).not.toBeNull();
      expect(config?.id).toBe('linear');
    });

    it('returns config when LINEAR_API_KEY is in env option', () => {
      const config = getMcpServerConfig('linear', { env: { LINEAR_API_KEY: 'lin_env_456' } });
      expect(config).not.toBeNull();
    });

    it('injects LINEAR_API_KEY into the transport env', () => {
      const config = getMcpServerConfig('linear', { linearApiKey: 'lin_inject' });
      expect(config?.transport.type).toBe('stdio');
      if (config?.transport.type === 'stdio') {
        expect(config.transport.env?.LINEAR_API_KEY).toBe('lin_inject');
        expect(config.transport.command).toBe('npx');
        expect(config.transport.args).toContain('mcp-remote');
        expect(config.transport.args).toContain('https://mcp.linear.app/mcp');
      }
    });
  });

  describe('memory', () => {
    it('returns null when no memory URL provided', () => {
      const config = getMcpServerConfig('memory', {});
      expect(config).toBeNull();
    });

    it('returns config with streamable-http transport when URL is provided', () => {
      const config = getMcpServerConfig('memory', { memoryMcpUrl: 'http://localhost:8080/mcp' });
      expect(config).not.toBeNull();
      expect(config?.transport.type).toBe('streamable-http');
      if (config?.transport.type === 'streamable-http') {
        expect(config.transport.url).toBe('http://localhost:8080/mcp');
      }
    });

    it('reads URL from env.GRAPHITI_MCP_URL option', () => {
      const config = getMcpServerConfig('memory', { env: { GRAPHITI_MCP_URL: 'http://graphiti.local' } });
      expect(config?.transport.type).toBe('streamable-http');
    });
  });

  describe('electron', () => {
    it('returns the electron server config', () => {
      const config = getMcpServerConfig('electron');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('electron');
      expect(config?.enabledByDefault).toBe(false);
    });

    it('uses stdio transport', () => {
      const config = getMcpServerConfig('electron');
      expect(config?.transport.type).toBe('stdio');
    });
  });

  describe('puppeteer', () => {
    it('returns the puppeteer server config', () => {
      const config = getMcpServerConfig('puppeteer');
      expect(config).not.toBeNull();
      expect(config?.id).toBe('puppeteer');
    });

    it('uses stdio transport', () => {
      const config = getMcpServerConfig('puppeteer');
      expect(config?.transport.type).toBe('stdio');
    });
  });

  describe('auto-claude', () => {
    it('returns null because auto-claude tools are registered in-process', () => {
      const config = getMcpServerConfig('auto-claude', {});
      expect(config).toBeNull();
    });
  });

  describe('unknown server', () => {
    it('returns null for unrecognized server ID', () => {
      const config = getMcpServerConfig('nonexistent-server');
      expect(config).toBeNull();
    });
  });
});

// =============================================================================
// resolveMcpServers
// =============================================================================

describe('resolveMcpServers', () => {
  it('returns configs for all recognized server IDs', () => {
    const configs = resolveMcpServers(['context7', 'electron', 'puppeteer']);
    expect(configs).toHaveLength(3);
    expect(configs.map((c) => c.id)).toEqual(['context7', 'electron', 'puppeteer']);
  });

  it('filters out servers that cannot be configured (e.g. linear without API key)', () => {
    const configs = resolveMcpServers(['context7', 'linear'], {});
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('context7');
  });

  it('includes linear when API key option is provided', () => {
    const configs = resolveMcpServers(['context7', 'linear'], { linearApiKey: 'lin_test' });
    expect(configs).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    const configs = resolveMcpServers([]);
    expect(configs).toEqual([]);
  });

  it('skips unrecognized server IDs silently', () => {
    const configs = resolveMcpServers(['context7', 'bogus-server-id']);
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('context7');
  });

  it('includes memory server when memoryMcpUrl is provided', () => {
    const configs = resolveMcpServers(['memory'], { memoryMcpUrl: 'http://memory.local' });
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe('memory');
  });

  it('skips auto-claude because its tools are registered in-process', () => {
    const configs = resolveMcpServers(['auto-claude'], { specDir: '/my-project/.auto-claude/specs/042-auth' });
    expect(configs).toEqual([]);
  });

  it('normalizes custom command servers from UI config', () => {
    const configs = resolveMcpServers(['custom-memory'], {
      customMcpServers: [{
        id: 'custom-memory',
        name: 'Custom Memory',
        type: 'command',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: { MEMORY_FILE_PATH: '/tmp/memory.jsonl' },
      } as never],
    });

    expect(configs).toHaveLength(1);
    if (configs[0].transport.type === 'stdio') {
      expect(configs[0].transport.command).toBe('npx');
      expect(configs[0].transport.env?.MEMORY_FILE_PATH).toBe('/tmp/memory.jsonl');
    }
  });

  it('normalizes custom HTTP servers from UI config through mcp-remote', () => {
    const configs = resolveMcpServers(['neon'], {
      customMcpServers: [{
        id: 'neon',
        name: 'Neon',
        type: 'http',
        url: 'https://mcp.neon.tech/mcp',
        headers: { Authorization: 'Bearer token' },
      } as never],
    });

    expect(configs).toHaveLength(1);
    if (configs[0].transport.type === 'stdio') {
      expect(configs[0].transport.command).toBe('npx');
      expect(configs[0].transport.args).toContain('mcp-remote');
      expect(configs[0].transport.args).toContain('https://mcp.neon.tech/mcp');
      expect(configs[0].transport.args).toContain('Authorization: ${MCP_NEON_AUTHORIZATION_HEADER}');
      expect(configs[0].transport.env?.MCP_NEON_AUTHORIZATION_HEADER).toBe('Bearer token');
    }
  });
});
