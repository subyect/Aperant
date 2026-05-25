import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(),
}));

import { readSettingsFile } from '../settings-utils';
import { getActiveProviderFeatureSettings, resolveActiveProviderFeatureModel } from './feature-settings-helper';

const mockReadSettingsFile = vi.mocked(readSettingsFile);
const tempDirs: string[] = [];

function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
}

function createCodexUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aperant-codex-feature-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'codex-auth.json'), JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 60_000,
  }));
  return dir;
}

describe('getActiveProviderFeatureSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APERANT_USER_DATA_DIR;
    cleanupTempDirs();
  });

  afterAll(() => {
    delete process.env.APERANT_USER_DATA_DIR;
    cleanupTempDirs();
  });

  it('falls back from stale feature model IDs to an OpenAI subscription-compatible model', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
      featureModels: {
        insights: 'gpt-5.5',
      },
      featureThinking: {
        insights: 'medium',
      },
    });

    expect(getActiveProviderFeatureSettings('insights')).toEqual({
      model: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    });
  });

  it('does not route API-key-only OpenAI models through subscription accounts', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
      featureModels: {
        insights: 'gpt-5.2',
      },
    });

    expect(getActiveProviderFeatureSettings('insights').model).toBe('gpt-5.3-codex');
  });

  it('upgrades deprecated OpenAI Codex subscription models', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
      featureModels: {
        utility: 'gpt-5.1-codex-mini',
      },
    });

    expect(getActiveProviderFeatureSettings('utility').model).toBe('gpt-5.3-codex');
  });

  it('normalizes explicit feature model choices against the active OpenAI subscription account', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
    });

    expect(resolveActiveProviderFeatureModel('insights', 'gpt-5.5')).toBe('gpt-5.3-codex');
    expect(resolveActiveProviderFeatureModel('insights', 'opus')).toBe('gpt-5.3-codex');
  });

  it('treats stored Codex OAuth tokens as the active OpenAI subscription account', () => {
    process.env.APERANT_USER_DATA_DIR = createCodexUserDataDir();
    mockReadSettingsFile.mockReturnValue({
      providerAccounts: [],
      featureModels: {
        insights: 'sonnet',
      },
      featureThinking: {
        insights: 'medium',
      },
    });

    expect(getActiveProviderFeatureSettings('insights')).toEqual({
      model: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    });
  });
});
