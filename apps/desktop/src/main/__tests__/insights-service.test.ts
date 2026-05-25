import { describe, expect, it } from 'vitest';

import { buildInsightsConversationHistory } from '../insights-service';
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
