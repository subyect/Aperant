import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRunInsightsQuery = vi.hoisted(() => vi.fn());
const mockResolveInsightsModelConfig = vi.hoisted(() => vi.fn());

vi.mock('../ai/runners/insights', () => ({
  runInsightsQuery: (...args: unknown[]) => mockRunInsightsQuery(...args),
}));

vi.mock('./model-config', () => ({
  resolveInsightsModelConfig: (...args: unknown[]) => mockResolveInsightsModelConfig(...args),
}));

import { InsightsExecutor } from './insights-executor';

describe('InsightsExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveInsightsModelConfig.mockReturnValue({
      profileId: 'balanced',
      model: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    });
    mockRunInsightsQuery.mockResolvedValue({
      text: 'ok',
      taskSuggestion: null,
      toolCalls: [],
    });
  });

  it('resolves stale session model config at the executor boundary', async () => {
    const executor = new InsightsExecutor({} as never);

    await executor.execute(
      'project-1',
      '/project',
      'Hi',
      [],
      { profileId: 'balanced', model: 'sonnet', thinkingLevel: 'medium' },
    );

    expect(mockResolveInsightsModelConfig).toHaveBeenCalledWith({
      profileId: 'balanced',
      model: 'sonnet',
      thinkingLevel: 'medium',
    });
    expect(mockRunInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        modelShorthand: 'gpt-5.3-codex',
        thinkingLevel: 'xhigh',
      }),
      expect.any(Function),
    );
  });
});
