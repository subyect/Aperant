import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(),
}));

import { readSettingsFile } from '../settings-utils';
import { resolveInsightsModelConfig } from './model-config';

const mockReadSettingsFile = vi.mocked(readSettingsFile);

describe('resolveInsightsModelConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes stale persisted OpenAI subscription chat models', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
      providerAgentConfig: {
        openai: {
          featureModels: {
            insights: 'gpt-5.3-codex',
          },
          featureThinking: {
            insights: 'xhigh',
          },
        },
      },
    });

    expect(resolveInsightsModelConfig({
      profileId: 'custom',
      model: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    })).toEqual({
      profileId: 'custom',
      model: 'gpt-5.5',
      thinkingLevel: 'high',
    });
  });

  it('maps Anthropic profile choices to the active OpenAI subscription model', () => {
    mockReadSettingsFile.mockReturnValue({
      globalPriorityOrder: ['openai-subscription'],
      providerAccounts: [{
        id: 'openai-subscription',
        provider: 'openai',
        authType: 'oauth',
        billingModel: 'subscription',
      }],
      providerAgentConfig: {
        openai: {
          featureModels: {
            insights: 'gpt-5.5',
          },
          featureThinking: {
            insights: 'xhigh',
          },
        },
      },
    });

    expect(resolveInsightsModelConfig({
      profileId: 'balanced',
      model: 'sonnet',
      thinkingLevel: 'medium',
    }).model).toBe('gpt-5.5');
  });
});
