import type { TaskStatus } from '../shared/types';
import { XSTATE_TO_PHASE, mapStateToLegacy } from '../shared/state-machines';

type MutablePlan = Record<string, any>;

export interface PlanCompletionCounts {
  allSubtasks: MutablePlan[];
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
}

export function checkSubtasksCompletion(plan: MutablePlan | null | undefined): PlanCompletionCounts {
  const allSubtasks = Array.isArray(plan?.phases)
    ? plan.phases.flatMap((phase: MutablePlan) => {
      const items = phase.subtasks || phase.chunks || [];
      return Array.isArray(items) ? items : [];
    })
    : [];
  const completedCount = allSubtasks.filter((subtask) => subtask?.status === 'completed').length;
  const totalCount = allSubtasks.length;
  return {
    allSubtasks,
    completedCount,
    totalCount,
    allCompleted: totalCount > 0 && completedCount === totalCount,
  };
}

export function getPlanCompletionCounts(plan: MutablePlan | null | undefined): Pick<PlanCompletionCounts, 'totalCount' | 'completedCount'> {
  const { totalCount, completedCount } = checkSubtasksCompletion(plan);
  return { totalCount, completedCount };
}

export function isQASignoffApproved(signoff: MutablePlan | null | undefined): boolean {
  return signoff?.approved === true || signoff?.status === 'passed' || signoff?.status === 'approved';
}

export function planHasMergeCompletionEvidence(plan: MutablePlan | null | undefined): boolean {
  const hasMergeCommit = typeof plan?.mergeCommit === 'string' && plan.mergeCommit.trim().length > 0;
  const hasMergedAt = typeof plan?.mergedAt === 'string' && plan.mergedAt.trim().length > 0;
  const hasFinalAcceptance = Array.isArray(plan?.final_acceptance) && plan.final_acceptance.length > 0;
  return hasMergeCommit && hasMergedAt && (hasFinalAcceptance || isQASignoffApproved(plan?.qa_signoff));
}

export function planHasFailedTerminalEvent(plan: MutablePlan | null | undefined): boolean {
  const eventType = plan?.lastEvent?.type || '';
  return eventType === 'CODING_FAILED' || /^QA_(?:FAILED|AGENT_ERROR|MAX_ITERATIONS|FIX_FAILED|REJECTED)/.test(eventType);
}

export function completedSubtasksHaveBlockingErrors(plan: MutablePlan | null | undefined): boolean {
  const subtasks = Array.isArray(plan?.phases)
    ? plan.phases.flatMap((phase: MutablePlan) => Array.isArray(phase.subtasks) ? phase.subtasks : [])
    : [];
  return subtasks.some((subtask: MutablePlan) => {
    if (subtask?.status !== 'completed') return false;
    const lastError = typeof subtask.last_error === 'string' ? subtask.last_error : '';
    return /appears to require repository changes|validation failed|qa failed|coding failed|max iterations/i.test(lastError);
  });
}

export function statusRequiresCompletedSubtasks(status: TaskStatus, reviewReason?: string): boolean {
  return status === 'done'
    || status === 'pr_created'
    || status === 'human_review' && (reviewReason === 'completed' || reviewReason === undefined);
}

export function doneStatusHasIncompleteSubtasks(plan: MutablePlan | null | undefined): {
  incomplete: boolean;
  completedCount: number;
  totalCount: number;
} {
  const { completedCount, totalCount, allCompleted } = checkSubtasksCompletion(plan);
  if (totalCount === 0) {
    return planHasMergeCompletionEvidence(plan)
      ? { incomplete: false, completedCount, totalCount }
      : { incomplete: true, completedCount, totalCount };
  }
  if (!allCompleted) {
    return { incomplete: true, completedCount, totalCount };
  }
  if (completedSubtasksHaveBlockingErrors(plan) && !planHasMergeCompletionEvidence(plan)) {
    return { incomplete: true, completedCount, totalCount };
  }
  if (isQASignoffApproved(plan?.qa_signoff)) {
    return { incomplete: false, completedCount, totalCount };
  }
  if (planHasFailedTerminalEvent(plan)) {
    return { incomplete: true, completedCount, totalCount };
  }
  return { incomplete: false, completedCount, totalCount };
}

export function applyRuntimePhaseState(plan: MutablePlan | null | undefined, phase?: string): boolean {
  if (!plan || !phase) return false;
  const phaseToRuntime: Record<string, MutablePlan> = {
    planning: { status: 'in_progress', planStatus: 'in_progress', xstateState: 'planning', executionPhase: 'planning' },
    coding: { status: 'in_progress', planStatus: 'in_progress', xstateState: 'coding', executionPhase: 'coding' },
    qa_review: { status: 'ai_review', planStatus: 'review', xstateState: 'qa_review', executionPhase: 'qa_review' },
    qa_fixing: { status: 'ai_review', planStatus: 'review', xstateState: 'qa_fixing', executionPhase: 'qa_fixing' },
    complete: { status: 'human_review', planStatus: 'review', xstateState: 'human_review', executionPhase: 'complete' },
    failed: { status: 'error', planStatus: 'error', xstateState: 'error', executionPhase: 'failed' },
    idle: { status: 'queue', planStatus: 'queued', xstateState: 'queue', executionPhase: 'idle' },
  };
  const runtime = phaseToRuntime[phase];
  if (!runtime || plan.status === 'done' || plan.status === 'pr_created') return false;

  let changed = false;
  for (const [key, value] of Object.entries(runtime)) {
    if (plan[key] !== value) {
      plan[key] = value;
      changed = true;
    }
  }
  if (runtime.status === 'in_progress') {
    changed = changed
      || plan.reviewReason !== undefined
      || plan.qa_signoff !== undefined
      || plan.final_acceptance !== undefined
      || plan.mergeCommit !== undefined
      || plan.mergedAt !== undefined;
    delete plan.reviewReason;
    delete plan.qa_signoff;
    delete plan.final_acceptance;
    delete plan.mergeCommit;
    delete plan.mergedAt;
  } else if (runtime.status === 'ai_review') {
    changed = changed || plan.reviewReason !== undefined;
    delete plan.reviewReason;
  }
  return changed;
}

export function applyTaskEventRuntimeState(plan: MutablePlan | null | undefined, eventType?: string): boolean {
  if (!plan || !eventType) return false;
  if (eventType === 'PLANNING_STARTED') return applyRuntimePhaseState(plan, 'planning');
  if (eventType === 'CODING_STARTED' || eventType === 'QA_FIXING_COMPLETE') return applyRuntimePhaseState(plan, 'coding');
  if (eventType === 'ALL_SUBTASKS_DONE' || eventType === 'QA_STARTED') return applyRuntimePhaseState(plan, 'qa_review');
  if (eventType === 'QA_FAILED' || eventType === 'QA_FIXING_STARTED') return applyRuntimePhaseState(plan, 'qa_fixing');
  if (eventType === 'QA_PASSED') return applyRuntimePhaseState(plan, 'complete');
  if (eventType === 'PLANNING_FAILED' || eventType === 'CODING_FAILED' || eventType === 'QA_MAX_ITERATIONS' || eventType === 'QA_AGENT_ERROR') {
    return applyRuntimePhaseState(plan, 'failed');
  }
  return false;
}

export function preserveCompletedSubtasks(targetPlan: MutablePlan | null | undefined, sourcePlan: MutablePlan | null | undefined): boolean {
  if (!targetPlan || !sourcePlan || !Array.isArray(targetPlan.phases) || !Array.isArray(sourcePlan.phases)) return false;
  const completedById = new Map<string, MutablePlan>();
  for (const phase of sourcePlan.phases) {
    for (const subtask of Array.isArray(phase.subtasks) ? phase.subtasks : []) {
      if (subtask?.id && subtask.status === 'completed') {
        completedById.set(String(subtask.id), subtask);
      }
    }
  }
  let changed = false;
  for (const phase of targetPlan.phases) {
    for (const subtask of Array.isArray(phase.subtasks) ? phase.subtasks : []) {
      const completed = completedById.get(String(subtask?.id));
      if (completed && subtask.status !== 'completed') {
        Object.assign(subtask, completed);
        changed = true;
      }
    }
  }
  return changed;
}

export function restampPlanFromXState(plan: MutablePlan | null | undefined, xstateState?: string): boolean {
  if (!plan || !xstateState) return false;
  const phase = XSTATE_TO_PHASE[xstateState];
  const legacy = mapStateToLegacy(xstateState as never, plan.reviewReason);
  let changed = applyRuntimePhaseState(plan, phase);
  if (plan.status !== legacy.status && plan.status !== 'done' && plan.status !== 'pr_created') {
    plan.status = legacy.status;
    plan.planStatus = legacy.status === 'ai_review' || legacy.status === 'human_review' ? 'review' : legacy.status;
    changed = true;
  }
  if (legacy.reviewReason !== undefined && plan.reviewReason !== legacy.reviewReason) {
    plan.reviewReason = legacy.reviewReason;
    changed = true;
  }
  return changed;
}

export function shouldCopyTerminalRuntimeStateFromSourcePlan(sourcePlan: MutablePlan | null | undefined): boolean {
  return sourcePlan?.status === 'human_review'
    || sourcePlan?.status === 'done'
    || sourcePlan?.status === 'pr_created'
    || sourcePlan?.executionPhase === 'complete'
    || isQASignoffApproved(sourcePlan?.qa_signoff);
}

export function copyRuntimeStateFromSourcePlan(targetPlan: MutablePlan | null | undefined, sourcePlan: MutablePlan | null | undefined): boolean {
  if (!targetPlan || !sourcePlan || !shouldCopyTerminalRuntimeStateFromSourcePlan(sourcePlan)) return false;
  let changed = false;
  for (const key of ['status', 'planStatus', 'reviewReason', 'xstateState', 'executionPhase', 'qa_signoff', 'final_acceptance', 'lastEvent'] as const) {
    if (sourcePlan[key] !== undefined && JSON.stringify(targetPlan[key]) !== JSON.stringify(sourcePlan[key])) {
      targetPlan[key] = sourcePlan[key];
      changed = true;
    }
  }
  return changed;
}

export function planHasFailedValidation(plan: MutablePlan | null | undefined): boolean {
  return plan?.status === 'error'
    || plan?.reviewReason === 'errors'
    || plan?.executionPhase === 'failed'
    || /^QA_/.test(plan?.lastEvent?.type || '')
    || plan?.lastEvent?.type === 'CODING_FAILED';
}

export function isIncompleteSettledPlan(plan: MutablePlan | null | undefined): boolean {
  const { totalCount, completedCount } = getPlanCompletionCounts(plan);
  if (totalCount === 0 || completedCount >= totalCount) return false;
  return plan?.status === 'done'
    || plan?.status === 'pr_created'
    || plan?.status === 'error'
    || plan?.status === 'human_review' && (plan?.reviewReason === 'completed' || plan?.reviewReason === 'errors' || plan?.reviewReason === 'qa_rejected')
    || plan?.executionPhase === 'failed'
    || /^QA_/.test(plan?.lastEvent?.type || '')
    || plan?.lastEvent?.type === 'CODING_FAILED';
}

export function getPlanContinuationMode(plan: MutablePlan | null | undefined): 'coding' | 'qa' | null {
  const { totalCount, completedCount } = getPlanCompletionCounts(plan);
  if (totalCount === 0) return null;
  if (completedCount < totalCount) return 'coding';
  return isQASignoffApproved(plan?.qa_signoff) ? null : 'qa';
}

export function planNeedsContinuationAfterExit(plan: MutablePlan | null | undefined, exitCode: number | null): 'coding' | 'qa' | null {
  const mode = getPlanContinuationMode(plan);
  if (!mode && exitCode !== 0 && planHasFailedValidation(plan)) {
    const { totalCount, completedCount } = getPlanCompletionCounts(plan);
    if (totalCount > 0 && completedCount >= totalCount) return 'qa';
  }
  if (!mode) return null;
  if (exitCode === 0) return mode;
  return isIncompleteSettledPlan(plan) || mode === 'qa' || planHasFailedValidation(plan) ? mode : null;
}

export function createApprovedQASignoffFromReport(source = 'qa_report'): MutablePlan {
  return {
    status: 'approved',
    issues_found: [],
    timestamp: new Date().toISOString(),
    source,
  };
}
