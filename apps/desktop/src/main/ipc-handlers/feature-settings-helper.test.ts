import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(),
}));

import { readSettingsFile } from '../settings-utils';
import { getActiveProviderFeatureSettings } from './feature-settings-helper';

const mockReadSettingsFile = vi.mocked(readSettingsFile);

describe('getActiveProviderFeatureSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      model: 'gpt-5.2-codex',
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

    expect(getActiveProviderFeatureSettings('insights').model).toBe('gpt-5.2-codex');
  });

  it('keeps supported OpenAI Codex subscription models', () => {
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

    expect(getActiveProviderFeatureSettings('utility').model).toBe('gpt-5.1-codex-mini');
  });
});
