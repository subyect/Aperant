import { describe, expect, it } from 'vitest';

import { doneStatusHasIncompleteSubtasks } from '../task-plan-guards';

function planWithSubtasks(subtasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    status: 'done',
    phases: [
      {
        name: 'Phase 1',
        subtasks,
      },
    ],
    ...extra,
  };
}

describe('doneStatusHasIncompleteSubtasks', () => {
  it('blocks done when approved QA only covers a completed subtask with blocking execution errors', () => {
    const result = doneStatusHasIncompleteSubtasks(planWithSubtasks([
      {
        id: '1.1',
        status: 'completed',
        last_error: 'Subtask 1.1 appears to require repository changes, but no non-.auto-claude files changed.',
      },
    ], {
      qa_signoff: { status: 'approved', issues_found: [] },
    }));

    expect(result).toEqual({ incomplete: true, completedCount: 1, totalCount: 1 });
  });

  it('allows stale completed-subtask errors after verified app merge evidence exists', () => {
    const result = doneStatusHasIncompleteSubtasks(planWithSubtasks([
      {
        id: '1.1',
        status: 'completed',
        last_error: 'Subtask 1.1 appears to require repository changes, but no non-.auto-claude files changed.',
      },
    ], {
      qa_signoff: { status: 'approved', issues_found: [] },
      final_acceptance: ['Focused tests passed'],
      mergeCommit: 'abc1234',
      mergedAt: '2026-05-23T12:00:00.000Z',
    }));

    expect(result).toEqual({ incomplete: false, completedCount: 1, totalCount: 1 });
  });
});
