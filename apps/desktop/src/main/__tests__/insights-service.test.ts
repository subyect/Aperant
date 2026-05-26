import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildInsightsConversationHistory, InsightsService } from '../insights-service';
import type { InsightsChatMessage } from '../../shared/types';

function message(
  role: InsightsChatMessage['role'],
  content: string,
  overrides: Partial<InsightsChatMessage> = {},
): InsightsChatMessage {
  return {
    id: `${role}-${content}`,
    role,
    content,
    timestamp: new Date('2026-05-25T10:00:00Z'),
    ...overrides,
  };
}

describe('buildInsightsConversationHistory', () => {
  it('excludes the current user message so the prompt is not duplicated', () => {
    const history = buildInsightsConversationHistory([
      message('user', 'Earlier question'),
      message('assistant', 'Earlier answer'),
      message('user', 'Current question'),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
    ]);
  });

  it('drops blank and transient failed assistant turns from persisted chat history', () => {
    const history = buildInsightsConversationHistory([
      message('user', 'Hi'),
      message('assistant', ''),
      message('assistant', 'Insights request failed: Bad Request'),
      message('assistant', 'Failed to send message: OpenAI API key is missing'),
      message('assistant', 'Recovered answer'),
      message('user', 'Current question'),
    ]);

    expect(history).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Recovered answer' },
    ]);
  });

  it('keeps historical image context without pretending the old image is still attached', () => {
    const history = buildInsightsConversationHistory([
      message('user', 'Look at this', {
        images: [{
          id: 'img-1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          size: 123,
          thumbnail: 'data:image/png;base64,abc',
        }],
      }),
      message('assistant', 'I see it.'),
      message('user', 'Current question'),
    ]);

    expect(history[0].content).toContain('Look at this');
    expect(history[0].content).toContain('previously attached 1 image');
  });
});

describe('InsightsService error persistence', () => {
  let projectPath: string | null = null;

  afterEach(() => {
    if (projectPath) {
      rmSync(projectPath, { recursive: true, force: true });
      projectPath = null;
    }
  });

  it('persists failed responses as transient assistant turns instead of leaving a blank chat', async () => {
    projectPath = mkdtempSync(path.join(tmpdir(), 'aperant-insights-error-'));
    const service = new InsightsService();
    const executor = (service as unknown as {
      executor: {
        execute: (...args: unknown[]) => Promise<unknown>;
        cancelSession: (projectId: string) => boolean;
      };
    }).executor;
    vi.spyOn(executor, 'cancelSession').mockReturnValue(false);
    vi.spyOn(executor, 'execute').mockRejectedValue(new Error('Bad Request: model does not support tools'));

    const sessionUpdates: unknown[] = [];
    service.on('session-updated', (_projectId, session) => sessionUpdates.push(session));

    await service.sendMessage('project-1', projectPath, 'Hi');

    const session = service.loadSession('project-1', projectPath);
    expect(session?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi'],
      ['assistant', 'Insights request failed: Bad Request: model does not support tools'],
    ]);
    expect(sessionUpdates).toHaveLength(1);
  });
});
