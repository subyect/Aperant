import { describe, expect, it } from 'vitest';

import {
  applyTaskEventRuntimeState,
  doneStatusHasIncompleteSubtasks,
  isIncompleteSettledPlan,
  statusRequiresCompletedSubtasks,
} from '../task-plan-guards';

function planWithSubtasks(subtasks: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, any> {
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

describe('statusRequiresCompletedSubtasks', () => {
  it('allows plan review without completed subtasks but guards terminal human review reasons', () => {
    expect(statusRequiresCompletedSubtasks('human_review', 'plan_review')).toBe(false);
    expect(statusRequiresCompletedSubtasks('human_review', 'completed')).toBe(true);
    expect(statusRequiresCompletedSubtasks('human_review', 'stopped')).toBe(true);
    expect(statusRequiresCompletedSubtasks('human_review', 'errors')).toBe(true);
    expect(statusRequiresCompletedSubtasks('human_review', 'qa_rejected')).toBe(true);
  });
});

describe('runtime completion guards', () => {
  it('keeps stale QA_PASSED events from finalizing plans with pending subtasks', () => {
    const plan = planWithSubtasks([
      { id: '1.1', status: 'completed' },
      { id: '1.2', status: 'pending' },
    ], {
      status: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
    });

    expect(applyTaskEventRuntimeState(plan, 'QA_PASSED')).toBe(true);

    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.recoveryNote).toBe('Blocked terminal event QA_PASSED: 1/2 subtasks complete.');
  });

  it('treats stopped human review with pending subtasks as incomplete settled work', () => {
    expect(isIncompleteSettledPlan(planWithSubtasks([
      { id: '1.1', status: 'completed' },
      { id: '1.2', status: 'pending' },
    ], {
      status: 'human_review',
      reviewReason: 'stopped',
      executionPhase: 'complete',
    }))).toBe(true);
  });
});
