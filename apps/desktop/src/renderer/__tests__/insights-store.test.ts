import { describe, expect, it } from 'vitest';

import {
  shouldAdoptInsightsSessionUpdate,
} from '../stores/insights-store';
import type { InsightsSession } from '../../shared/types';

function session(overrides: Partial<InsightsSession> = {}): InsightsSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'New Conversation',
    messages: [],
    createdAt: new Date('2026-05-26T10:00:00Z'),
    updatedAt: new Date('2026-05-26T10:00:00Z'),
    ...overrides,
  };
}

describe('shouldAdoptInsightsSessionUpdate', () => {
  it('adopts the server session when no local session is loaded', () => {
    expect(shouldAdoptInsightsSessionUpdate(null, 'project-1', session())).toBe(true);
  });

  it('adopts updates for the active persisted session', () => {
    expect(shouldAdoptInsightsSessionUpdate(
      session({ id: 'session-1' }),
      'project-1',
      session({ id: 'session-1' }),
    )).toBe(true);
  });

  it('replaces the local optimistic session with the persisted session for the project', () => {
    expect(shouldAdoptInsightsSessionUpdate(
      session({ id: 'pending-insights-session-123' }),
      'project-1',
      session({ id: 'session-2' }),
    )).toBe(true);
  });

  it('does not overwrite a different session after the user switches chats', () => {
    expect(shouldAdoptInsightsSessionUpdate(
      session({ id: 'session-opened-by-user' }),
      'project-1',
      session({ id: 'session-background-response' }),
    )).toBe(false);
  });
});
