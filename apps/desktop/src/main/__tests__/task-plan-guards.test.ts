import { describe, expect, it } from 'vitest';

import {
  applyTaskEventRuntimeState,
  clearCompletedSubtaskDiagnostics,
  doneStatusHasIncompleteSubtasks,
  planNeedsContinuationAfterExit,
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

  it('blocks terminal done when all subtasks are complete but QA and merge evidence are missing', () => {
    const result = doneStatusHasIncompleteSubtasks(planWithSubtasks([
      { id: '1.1', status: 'completed' },
      { id: '1.2', status: 'completed' },
    ]));

    expect(result).toEqual({ incomplete: true, completedCount: 2, totalCount: 2 });
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

describe('clearCompletedSubtaskDiagnostics', () => {
  it('removes stale retry errors from completed subtasks only', () => {
    const plan = planWithSubtasks([
      {
        id: '1.1',
        status: 'completed',
        last_error: 'Agent session ended without marking the subtask completed.',
        last_attempt_outcome: 'completed',
        last_attempt_at: '2026-05-25T10:00:00.000Z',
      },
      {
        id: '1.2',
        status: 'pending',
        last_error: 'Still failing.',
        last_attempt_outcome: 'error',
        last_attempt_at: '2026-05-25T10:01:00.000Z',
      },
    ]);

    expect(clearCompletedSubtaskDiagnostics(plan)).toBe(true);

    expect(plan.phases[0].subtasks[0].last_error).toBeUndefined();
    expect(plan.phases[0].subtasks[0].last_attempt_outcome).toBeUndefined();
    expect(plan.phases[0].subtasks[0].last_attempt_at).toBeUndefined();
    expect(plan.phases[0].subtasks[1].last_error).toBe('Still failing.');
    expect(plan.phases[0].subtasks[1].last_attempt_outcome).toBe('error');
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

  it('keeps QA fixing events in coding while recovery subtasks are pending', () => {
    const plan = planWithSubtasks([
      { id: '1.1', status: 'completed' },
      { id: 'aperant-qa-report-failure', status: 'pending' },
    ], {
      status: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      qa_signoff: { status: 'approved', issues_found: [] },
    });

    expect(applyTaskEventRuntimeState(plan, 'QA_FIXING_STARTED')).toBe(true);

    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.qa_signoff).toBeUndefined();
  });

  it('turns QA_PASSED with completed subtasks into approved human review even if qa_signoff is missing', () => {
    const plan = planWithSubtasks([
      { id: '1.1', status: 'completed' },
      { id: '1.2', status: 'completed' },
    ], {
      status: 'ai_review',
      xstateState: 'qa_review',
      executionPhase: 'qa_review',
      recoveryNote: 'Blocked terminal event QA_PASSED: 2/2 subtasks complete.',
    });

    expect(applyTaskEventRuntimeState(plan, 'QA_PASSED')).toBe(true);

    expect(plan.status).toBe('human_review');
    expect(plan.xstateState).toBe('human_review');
    expect(plan.executionPhase).toBe('complete');
    expect(plan.reviewReason).toBe('completed');
    expect(plan.qa_signoff).toEqual(expect.objectContaining({
      status: 'approved',
      source: 'QA_PASSED',
    }));
    expect(plan.recoveryNote).toBeUndefined();
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

  it('continues zero-subtask planning failures in planning mode', () => {
    expect(planNeedsContinuationAfterExit({
      status: 'error',
      executionPhase: 'failed',
      phases: [],
      lastEvent: { type: 'CODING_FAILED' },
    }, 1)).toBe('planning');
  });

  it('continues active zero-subtask planning exits instead of settling idle', () => {
    expect(planNeedsContinuationAfterExit({
      status: 'in_progress',
      xstateState: 'planning',
      executionPhase: 'planning',
      phases: [],
    }, 0)).toBe('planning');
  });
});
