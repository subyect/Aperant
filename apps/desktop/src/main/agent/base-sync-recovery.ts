export const BASE_SYNC_RECOVERY_SUBTASK_ID = 'aperant-base-sync-conflict';
export const BASE_SYNC_RECOVERY_NOTE = 'Base branch sync conflict while updating task worktree; continuing implementation.';

type RecordLike = Record<string, any>;

function sameStringArray(a: unknown, b: string[]): boolean {
  return Array.isArray(a)
    && a.length === b.length
    && a.every((value, index) => value === b[index]);
}

function getBaseSyncRecoverySubtask(plan: RecordLike): RecordLike | null {
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  for (const phase of phases) {
    const subtasks = Array.isArray(phase?.subtasks) ? phase.subtasks : [];
    const subtask = subtasks.find((candidate: RecordLike) => candidate?.id === BASE_SYNC_RECOVERY_SUBTASK_ID);
    if (subtask) return subtask;
  }
  return null;
}

export function isBaseSyncConflictRecoveryCurrent(
  plan: RecordLike,
  normalizedFiles: string[],
  reason: string,
  recoveryDescription: string,
): boolean {
  const recoverySubtask = getBaseSyncRecoverySubtask(plan);
  if (!recoverySubtask) return false;

  const verificationRun = recoverySubtask.verification?.run;
  const conflict = plan.base_sync_conflict;

  return (
    plan.status === 'in_progress'
    && plan.planStatus === 'in_progress'
    && plan.xstateState === 'coding'
    && plan.executionPhase === 'coding'
    && plan.recoveryNote === BASE_SYNC_RECOVERY_NOTE
    && plan.reviewReason === undefined
    && plan.qa_signoff === undefined
    && plan.final_acceptance === undefined
    && plan.lastEvent?.type === 'BASE_SYNC_CONFLICT'
    && sameStringArray(conflict?.files, normalizedFiles)
    && conflict?.reason === reason
    && recoverySubtask.title === 'Resolve base branch sync conflicts'
    && recoverySubtask.description === recoveryDescription
    && (recoverySubtask.status === 'pending' || recoverySubtask.status === 'in_progress')
    && recoverySubtask.verification?.type === 'command'
    && verificationRun === 'git diff --name-only --diff-filter=U && git status --short'
  );
}
