import { describe, expect, it } from 'vitest';
import {
  canAutoMergeCompletedHumanReviewPlans,
  canAutoMergeCompletedHumanReviewTask,
} from '../human-review-merge-guard';

function task(overrides: Record<string, unknown> = {}) {
  return {
    status: 'human_review',
    reviewReason: 'completed',
    subtasks: [],
    ...overrides,
  } as any;
}

function plan(statuses: string[]) {
  return {
    status: 'human_review',
    reviewReason: 'completed',
    phases: [
      {
        id: 'P1',
        subtasks: statuses.map((status, index) => ({ id: `P1-S${index + 1}`, status })),
      },
    ],
  };
}

describe('canAutoMergeCompletedHumanReviewTask', () => {
  it('allows auto-merge from cached completed subtasks', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task({
      subtasks: [{ id: 'P1-S1', status: 'completed' }],
    }))).toBe(true);
  });

  it('falls back to persisted plan completion when cached subtasks are missing', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task(), [plan(['completed', 'completed'])])).toBe(true);
  });

  it('does not auto-merge when persisted plan still has pending subtasks', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task(), [plan(['completed', 'pending'])])).toBe(false);
  });

  it('does not let stale cached completion override pending persisted subtasks', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task({
      subtasks: [{ id: 'P1-S1', status: 'completed' }],
    }), [plan(['completed', 'pending'])])).toBe(false);
  });

  it('does not auto-merge while human feedback is still pending', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task(), [{
      ...plan(['completed']),
      human_feedback_pending: { requested_at: '2026-05-26T08:00:00.000Z' },
    }])).toBe(false);
  });

  it('does not auto-merge non-completed human review tasks', () => {
    expect(canAutoMergeCompletedHumanReviewTask(task({ reviewReason: 'errors' }), [plan(['completed'])])).toBe(false);
  });
});

describe('canAutoMergeCompletedHumanReviewPlans', () => {
  it('allows persisted human-review evidence when the cached task object is stale', () => {
    expect(canAutoMergeCompletedHumanReviewPlans([
      plan(['completed', 'completed']),
      { ...plan(['completed', 'completed']), status: 'ai_review' },
    ])).toBe(true);
  });

  it('blocks persisted human-review evidence when any persisted plan is incomplete', () => {
    expect(canAutoMergeCompletedHumanReviewPlans([
      plan(['completed', 'completed']),
      { ...plan(['completed', 'pending']), status: 'ai_review' },
    ])).toBe(false);
  });
});
