/**
 * Plan File Utilities
 *
 * Provides thread-safe operations for reading and writing implementation_plan.json files.
 * Uses an in-memory lock to serialize updates and prevent race conditions when multiple
 * IPC handlers try to update the same plan file concurrently.
 *
 * IMPORTANT LIMITATION:
 * The synchronous function `persistPlanStatusSync` does NOT participate in the locking
 * mechanism. It bypasses the async lock entirely, which means:
 * - It can race with concurrent async operations (persistPlanStatus, updatePlanFile, etc.)
 * - It should ONLY be used when you are certain no async operations are pending on the same file
 * - Prefer using the async `persistPlanStatus` whenever possible
 *
 * If you need synchronous behavior, ensure that:
 * 1. No async plan operations are in flight for the same file path
 * 2. The calling context truly cannot use async/await (e.g., synchronous event handlers)
 */

import path from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { TaskStatus, Project, Task } from '../../../shared/types';
import { projectStore } from '../../project-store';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { safeParseJson } from '../../utils/json-repair';
import { getToolPath } from '../../cli-tool-manager';
import { getIsolatedGitEnv } from '../../utils/git-isolation';
import { findTaskWorktree } from '../../worktree-paths';
import {
  applyRuntimePhaseState,
  applyTaskEventRuntimeState,
  checkSubtasksCompletion,
  copyRuntimeStateFromSourcePlan,
  createApprovedQASignoffFromReport,
  doneStatusHasIncompleteSubtasks,
  isQASignoffApproved,
  preserveCompletedSubtasks,
  statusRequiresCompletedSubtasks,
} from '../../task-plan-guards';
import { XSTATE_ACTIVE_STATES, XSTATE_TO_PHASE } from '../../../shared/state-machines';

// In-memory locks for plan file operations
// Key: plan file path, Value: Promise chain for serializing operations
const planLocks = new Map<string, Promise<void>>();

/**
 * Serialize operations on a specific plan file to prevent race conditions.
 * Each operation waits for the previous one to complete before starting.
 */
async function withPlanLock<T>(planPath: string, operation: () => Promise<T>): Promise<T> {
  // Get or create the lock chain for this file
  const currentLock = planLocks.get(planPath) || Promise.resolve();

  // Create a new promise that will resolve after our operation completes
  let resolve: () => void;
  const newLock = new Promise<void>((r) => { resolve = r; });
  planLocks.set(planPath, newLock);

  try {
    // Wait for any previous operation to complete
    await currentLock;
    // Execute our operation
    return await operation();
  } finally {
    // Release the lock
    resolve!();
    // Clean up if this was the last operation
    if (planLocks.get(planPath) === newLock) {
      planLocks.delete(planPath);
    }
  }
}

/**
 * Check if an error is a "file not found" error
 */
function isFileNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export function safeReadFileSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Get the plan file path for a task
 */
export function getPlanPath(project: Project, task: Task): string {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(project.path, specsBaseDir, task.specId);
  return path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
}

/**
 * Map UI TaskStatus to Python-compatible planStatus
 */
export function mapStatusToPlanStatus(status: TaskStatus): string {
  switch (status) {
    case 'queue':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
    case 'human_review':
      return 'review';
    case 'done':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return 'pending';
  }
}

/**
 * Persist task status to implementation_plan.json file.
 * This is thread-safe and prevents race conditions when multiple handlers update the same file.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false if plan file doesn't exist
 */
export async function persistPlanStatus(planPath: string, status: TaskStatus, projectId?: string): Promise<boolean> {
  return withPlanLock(planPath, async () => {
    try {
      console.warn(`[plan-file-utils] Reading implementation_plan.json to update status to: ${status}`, { planPath });
      // Read file directly without existence check to avoid TOCTOU race condition
      const planContent = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, unknown>>(planContent);
      if (!plan) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - status not persisted`);
        return false;
      }

      const doneGuard = status === 'done' || status === 'pr_created'
        ? doneStatusHasIncompleteSubtasks(plan)
        : { incomplete: false, completedCount: 0, totalCount: 0 };
      const finalStatus = doneGuard.incomplete ? 'in_progress' : status;
      plan.status = finalStatus;
      plan.planStatus = mapStatusToPlanStatus(finalStatus);
      if (finalStatus === 'in_progress') {
        plan.xstateState = 'coding';
        plan.executionPhase = 'coding';
        plan.recoveryNote = `Blocked terminal status ${status}: ${doneGuard.completedCount}/${doneGuard.totalCount} subtasks complete.`;
        delete plan.reviewReason;
        delete plan.qa_signoff;
        delete plan.final_acceptance;
        delete plan.mergeCommit;
        delete plan.mergedAt;
      }
      plan.updated_at = new Date().toISOString();

      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[plan-file-utils] Successfully persisted status: ${status} to implementation_plan.json`);

      // Invalidate tasks cache since status changed
      if (projectId) {
        projectStore.invalidateTasksCache(projectId);
      }

      return true;
    } catch (err) {
      // File not found is expected - return false
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.json not found at ${planPath} - status not persisted`);
        return false;
      }
      console.warn(`[plan-file-utils] Could not persist status to ${planPath}:`, err);
      return false;
    }
  });
}

/**
 * Persist task status synchronously (for use in event handlers where async isn't practical).
 *
 * WARNING: This function bypasses the async locking mechanism entirely!
 *
 * This means it can race with concurrent async operations (persistPlanStatus, updatePlanFile,
 * createPlanIfNotExists) that may be in flight for the same file. Using this function while
 * async operations are pending can result in:
 * - Lost updates (this write may overwrite changes from an async operation, or vice versa)
 * - Corrupted JSON (if writes interleave at the filesystem level)
 * - Inconsistent state between what was written and what the async operation expected to read
 *
 * ONLY use this function when ALL of the following conditions are met:
 * 1. You are in a synchronous context that cannot use async/await (e.g., certain event handlers)
 * 2. You are certain no async plan operations are pending or in-flight for this file path
 * 3. No other code will initiate async plan operations until this function returns
 *
 * When possible, prefer using the async `persistPlanStatus` function instead, which properly
 * participates in the locking mechanism and prevents race conditions.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false otherwise
 */
export function persistPlanStatusSync(planPath: string, status: TaskStatus, projectId?: string): boolean {
  try {
    // Read file directly without existence check to avoid TOCTOU race condition
    const planContent = readFileSync(planPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) {
      console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - sync status not persisted`);
      return false;
    }

    const doneGuard = status === 'done' || status === 'pr_created'
      ? doneStatusHasIncompleteSubtasks(plan)
      : { incomplete: false, completedCount: 0, totalCount: 0 };
    const finalStatus = doneGuard.incomplete ? 'in_progress' : status;
    plan.status = finalStatus;
    plan.planStatus = mapStatusToPlanStatus(finalStatus);
    if (finalStatus === 'in_progress') {
      plan.xstateState = 'coding';
      plan.executionPhase = 'coding';
      plan.recoveryNote = `Blocked terminal status ${status}: ${doneGuard.completedCount}/${doneGuard.totalCount} subtasks complete.`;
      delete plan.reviewReason;
      delete plan.qa_signoff;
      delete plan.final_acceptance;
      delete plan.mergeCommit;
      delete plan.mergedAt;
    }
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    // Invalidate tasks cache since status changed
    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    // File not found is expected - return false
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist status to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist lastEvent metadata synchronously.
 *
 * WARNING: This bypasses async locking. Use only in sync event handlers where
 * async isn't practical. Prefer updatePlanFile when possible.
 */
export function persistPlanLastEventSync(planPath: string, event: TaskEventPayload): boolean {
  try {
    const planContent = readFileSync(planPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) {
      console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - lastEvent not persisted`);
      return false;
    }

    plan.lastEvent = {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp
    };
    applyTaskEventRuntimeState(plan, event.type);
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist lastEvent to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist task status, reviewReason, XState state, and execution phase synchronously.
 * The xstateState and executionPhase are used to restore the exact machine state on reload,
 * distinguishing between e.g. 'planning' vs 'coding' when both have status 'in_progress'.
 *
 * If the plan file doesn't exist, creates a minimal plan with the status fields.
 * This ensures XState state is persisted even during early phases like spec creation.
 */
export function persistPlanStatusAndReasonSync(
  planPath: string,
  status: TaskStatus,
  reviewReason?: string,
  projectId?: string,
  xstateState?: string,
  executionPhase?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    try {
      const planContent = readFileSync(planPath, 'utf-8');
      const parsed = safeParseJson<Record<string, unknown>>(planContent);
      if (!parsed) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - status/reason not persisted`);
        return false;
      }
      plan = parsed;
    } catch (readErr) {
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }
      // File doesn't exist - create a minimal plan with just status fields
      // The spec runner will populate the full plan later
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = {
        created_at: new Date().toISOString(),
        phases: []
      };
      console.log(`[plan-file-utils] Creating minimal plan for XState persistence: ${planPath}`);
    }

    const activeGuard = statusRequiresCompletedSubtasks(status, reviewReason)
      ? doneStatusHasIncompleteSubtasks(plan)
      : { incomplete: false, completedCount: 0, totalCount: 0 };
    const finalStatus = activeGuard.incomplete ? 'in_progress' : status;
    const finalXStateState = activeGuard.incomplete ? 'coding' : xstateState;
    const finalExecutionPhase = activeGuard.incomplete ? 'coding' : executionPhase;
    plan.status = finalStatus;
    plan.planStatus = mapStatusToPlanStatus(finalStatus);
    if (finalStatus === 'in_progress') {
      delete plan.reviewReason;
      delete plan.qa_signoff;
      delete plan.final_acceptance;
      delete plan.mergeCommit;
      delete plan.mergedAt;
      plan.recoveryNote = `Blocked terminal status ${status}: ${activeGuard.completedCount}/${activeGuard.totalCount} subtasks complete.`;
    } else if (reviewReason !== undefined) {
      plan.reviewReason = reviewReason;
    } else {
      delete plan.reviewReason;
    }
    if (finalXStateState) {
      plan.xstateState = finalXStateState;
    }
    if (finalExecutionPhase) {
      plan.executionPhase = finalExecutionPhase;
    }
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist status/reason to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist execution phase to the plan file synchronously.
 * This is called when execution progress updates to ensure the phase
 * is persisted for restoration on app refresh.
 */
export function persistPlanPhaseSync(
  planPath: string,
  phase: string,
  projectId?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    try {
      const planContent = readFileSync(planPath, 'utf-8');
      const parsed = safeParseJson<Record<string, unknown>>(planContent);
      if (!parsed) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - phase not persisted`);
        return false;
      }
      plan = parsed;
    } catch (readErr) {
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }
      // File doesn't exist - create minimal plan
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = {
        created_at: new Date().toISOString(),
        phases: []
      };
    }

    const currentXState = typeof plan.xstateState === 'string' ? plan.xstateState : '';
    const currentXStatePhase = currentXState ? XSTATE_TO_PHASE[currentXState] : undefined;
    const isActiveRuntimeState = plan.status === 'in_progress'
      || plan.status === 'ai_review'
      || currentXState === 'planning'
      || currentXState === 'coding'
      || currentXState === 'qa_review'
      || currentXState === 'qa_fixing';

    // ProgressTracker can briefly emit "idle" while a worker is starting or
    // resetting. Do not let that overwrite active planning/coding state in the
    // plan file; the task detail view restores from executionPhase.
    let phaseToPersist = phase;
    if (phase === 'idle' && isActiveRuntimeState && currentXStatePhase) {
      phaseToPersist = currentXStatePhase;
    }

    // Build orchestration may briefly report its internal planning pass before
    // coding. Once XState has a coding actor and the plan already contains
    // subtasks, keep the durable phase at coding so in-progress task details
    // restore to the worker overview instead of an empty planning view.
    if (
      phase === 'planning'
      && currentXState === 'coding'
      && checkSubtasksCompletion(plan).totalCount > 0
    ) {
      phaseToPersist = 'coding';
    }

    if (
      phase === 'idle'
      && XSTATE_ACTIVE_STATES.has(currentXState)
      && plan.executionPhase === phaseToPersist
    ) {
      return false;
    }

    // Store the execution phase for restoration
    plan.executionPhase = phaseToPersist;

    // Also update status to match the phase so the card stays in the correct column on refresh
    // Map execution phase to TaskStatus for column placement
    const phaseToStatus: Record<string, TaskStatus> = {
      'planning': 'in_progress',
      'coding': 'in_progress',
      'qa_review': 'ai_review',
      'qa_fixing': 'ai_review',
      'complete': 'human_review',
      'failed': 'error'
    };
    const mappedStatus = phaseToStatus[phaseToPersist];
    if (mappedStatus) {
      const reviewReason = phaseToPersist === 'complete' ? 'completed' : undefined;
      const activeGuard = statusRequiresCompletedSubtasks(mappedStatus, reviewReason)
        ? doneStatusHasIncompleteSubtasks(plan)
        : { incomplete: false, completedCount: 0, totalCount: 0 };
      const finalStatus = activeGuard.incomplete ? 'in_progress' : mappedStatus;
      plan.status = finalStatus;
      plan.planStatus = mapStatusToPlanStatus(finalStatus);
      if (activeGuard.incomplete) {
        plan.xstateState = 'coding';
        plan.executionPhase = 'coding';
        plan.recoveryNote = `Blocked terminal phase ${phase}: ${activeGuard.completedCount}/${activeGuard.totalCount} subtasks complete.`;
      }
      if (mappedStatus === 'in_progress') {
        delete plan.reviewReason;
        delete plan.qa_signoff;
        delete plan.final_acceptance;
        delete plan.mergeCommit;
        delete plan.mergedAt;
      }
      if (finalStatus === 'in_progress') {
        delete plan.reviewReason;
        delete plan.qa_signoff;
        delete plan.final_acceptance;
        delete plan.mergeCommit;
        delete plan.mergedAt;
      }
    }

    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist phase to ${planPath}:`, err);
    return false;
  }
}

/**
 * Read and update the plan file atomically.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param updater - Function that receives the current plan and returns the updated plan
 * @returns The updated plan, or null if the file doesn't exist
 */
export async function updatePlanFile<T extends Record<string, unknown>>(
  planPath: string,
  updater: (plan: T) => T
): Promise<T | null> {
  return withPlanLock(planPath, async () => {
    try {
      console.warn(`[plan-file-utils] Reading implementation_plan.json for update`, { planPath });
      // Read file directly without existence check to avoid TOCTOU race condition
      const planContent = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<T>(planContent);
      if (!plan) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - update skipped`);
        return null;
      }

      const updatedPlan = updater(plan);
      // Add updated_at timestamp - use type assertion since T extends Record<string, unknown>
      (updatedPlan as Record<string, unknown>).updated_at = new Date().toISOString();

      writeFileAtomicSync(planPath, JSON.stringify(updatedPlan, null, 2));
      console.warn(`[plan-file-utils] Successfully updated implementation_plan.json`);
      return updatedPlan;
    } catch (err) {
      // File not found is expected - return null
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.json not found at ${planPath} - update skipped`);
        return null;
      }
      console.warn(`[plan-file-utils] Could not update plan at ${planPath}:`, err);
      return null;
    }
  });
}

/**
 * Create a new plan file if it doesn't exist.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param task - The task to create the plan for
 * @param status - Initial status for the plan
 * @param xstateState - Optional XState machine state for restoration
 */
export async function createPlanIfNotExists(
  planPath: string,
  task: Task,
  status: TaskStatus,
  xstateState?: string
): Promise<void> {
  return withPlanLock(planPath, async () => {
    // Try to read the file first - if it exists, do nothing
    try {
      readFileSync(planPath, 'utf-8');
      return; // File exists, nothing to do
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err; // Re-throw unexpected errors
      }
      // File doesn't exist, continue to create it
    }

    const plan: Record<string, unknown> = {
      feature: task.title,
      description: task.description || '',
      created_at: task.createdAt.toISOString(),
      updated_at: new Date().toISOString(),
      status: status,
      planStatus: mapStatusToPlanStatus(status),
      phases: []
    };

    // Include xstateState for accurate restoration on reload
    if (xstateState) {
      plan.xstateState = xstateState;
    }

    // Ensure directory exists - use try/catch pattern
    const planDir = path.dirname(planPath);
    try {
      mkdirSync(planDir, { recursive: true });
    } catch (err) {
      // Directory might already exist or be created concurrently - that's fine
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
  });
}

/**
 * Reset all stuck subtasks (in_progress or failed) to pending state.
 * This enables automatic recovery when tasks are interrupted by rate limits or errors.
 * Thread-safe with withPlanLock.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns Object with success flag and count of reset subtasks
 */
export async function resetStuckSubtasks(planPath: string, projectId?: string): Promise<{ success: boolean; resetCount: number }> {
  return withPlanLock(planPath, async () => {
    try {
      console.log(`[plan-file-utils] Reading implementation_plan.json to reset stuck subtasks`, { planPath });

      // Read file directly without existence check to avoid TOCTOU race condition
      const planContent = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, unknown>>(planContent);
      if (!plan) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - subtask reset skipped`);
        return { success: false, resetCount: 0 };
      }

      let resetCount = 0;

      // Iterate through all phases and subtasks
      if (plan.phases && Array.isArray(plan.phases)) {
        for (const phase of plan.phases) {
          if (phase.subtasks && Array.isArray(phase.subtasks)) {
            for (const subtask of phase.subtasks) {
              // Only reset subtasks that are stuck (in_progress or failed)
              // NEVER reset completed subtasks to avoid redoing work
              if (subtask.status === 'in_progress' || subtask.status === 'failed') {
                const originalStatus = subtask.status;
                subtask.status = 'pending';
                subtask.started_at = null;
                subtask.completed_at = null;
                resetCount++;
                console.log(`[plan-file-utils] Reset subtask ${subtask.id} from ${originalStatus} to pending`);
              }
            }
          }
        }
      }

      // Only write if we actually reset something
      if (resetCount > 0) {
        plan.updated_at = new Date().toISOString();
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        console.log(`[plan-file-utils] Successfully reset ${resetCount} stuck subtask(s) in implementation_plan.json`);

        // Invalidate tasks cache since subtask status changed
        if (projectId) {
          projectStore.invalidateTasksCache(projectId);
        }
      } else {
        console.log(`[plan-file-utils] No stuck subtasks found to reset`);
      }

      return { success: true, resetCount };
    } catch (err) {
      // File not found is expected - return success with 0 count
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.json not found at ${planPath} - no subtasks to reset`);
        return { success: false, resetCount: 0 };
      }
      console.warn(`[plan-file-utils] Could not reset stuck subtasks at ${planPath}:`, err);
      return { success: false, resetCount: 0 };
    }
  });
}

/**
 * Update task_metadata.json to add PR URL.
 * This is a simple JSON file update (no locking needed as it's rarely updated concurrently).
 *
 * @param metadataPath - Path to the task_metadata.json file
 * @param prUrl - The PR URL to add to metadata
 * @returns true if metadata was updated, false if file doesn't exist or failed
 */
export function updateTaskMetadataPrUrl(metadataPath: string, prUrl: string): boolean {
  try {
    let metadata: Record<string, unknown> = {};

    // Try to read existing metadata
    try {
      const content = readFileSync(metadataPath, 'utf-8');
      metadata = safeParseJson<Record<string, unknown>>(content) || {};
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err;
      }
      // File doesn't exist, will create new one
    }

    // Update with prUrl
    metadata.prUrl = prUrl;

    // Ensure parent directory exists before writing
    mkdirSync(path.dirname(metadataPath), { recursive: true });

    // Write back
    writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not update metadata at ${metadataPath}:`, err);
    return false;
  }
}

/**
 * Sync phases (subtask data) from a source plan to the main project's plan file.
 * This ensures that subtask completion statuses written by the agent in the worktree
 * are reflected in the main project plan, which is the source of truth for getTasks().
 *
 * Preserves all existing fields in the main plan (status, reviewReason, xstateState, etc.)
 * and only updates the phases array and updated_at timestamp.
 */
export function syncPlanPhasesToMainSync(
  mainPlanPath: string,
  sourcePlanOrPhases: unknown[] | Record<string, unknown>,
  projectId?: string
): boolean {
  try {
    const planContent = readFileSync(mainPlanPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) {
      console.warn(`[plan-file-utils] Unrepairable JSON in ${mainPlanPath} - phase sync skipped`);
      return false;
    }

    const sourcePlan = Array.isArray(sourcePlanOrPhases)
      ? { phases: sourcePlanOrPhases }
      : sourcePlanOrPhases;

    const sourceCounts = checkSubtasksCompletion(sourcePlan);
    const currentCounts = checkSubtasksCompletion(plan);
    if (sourceCounts.totalCount === 0 && currentCounts.totalCount > 0) {
      console.warn(
        `[plan-file-utils] Refusing to replace ${currentCounts.totalCount} existing subtasks ` +
        `with an empty source plan at ${mainPlanPath}`
      );
      return false;
    }

    preserveCompletedSubtasks(sourcePlan, plan);
    plan.phases = sourcePlan.phases;
    copyRuntimeStateFromSourcePlan(plan, sourcePlan);
    if (typeof sourcePlan.executionPhase === 'string') {
      applyRuntimePhaseState(plan, sourcePlan.executionPhase);
    }
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(mainPlanPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not sync phases to ${mainPlanPath}:`, err);
    return false;
  }
}

export function readApprovedQASignoffFromReportSync(specDir: string): Record<string, unknown> | null {
  try {
    const reportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
    const content = readFileSync(reportPath, 'utf-8');
    const match = content.match(/(?:^|\n)\s*(?:\*\*)?\s*Status\s*:\s*(PASSED|PASS|APPROVED)\s*(?:\*\*)?/i);
    return match ? createApprovedQASignoffFromReport('qa_report') : null;
  } catch {
    return null;
  }
}

export function getPlanPathsForSpec(project: Project, specId: string): string[] {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const paths = [
    path.join(project.path, specsBaseDir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)
  ];
  const worktreePath = findTaskWorktree(project.path, specId);
  if (worktreePath) {
    const worktreePlanPath = path.join(worktreePath, specsBaseDir, specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    if (!paths.includes(worktreePlanPath)) paths.push(worktreePlanPath);
  }
  return paths;
}

export function getApprovedQASignoffEvidence(
  project: Project,
  specId: string,
  planPaths = getPlanPathsForSpec(project, specId)
): { signoff: Record<string, unknown>; source: string } | null {
  let hasCompletedPlan = false;
  for (const planPath of planPaths) {
    try {
      const content = safeReadFileSync(planPath);
      if (!content) continue;
      const plan = safeParseJson<Record<string, unknown>>(content);
      if (!plan) continue;
      const { totalCount, completedCount } = checkSubtasksCompletion(plan);
      if (totalCount > 0 && completedCount >= totalCount) hasCompletedPlan = true;
      if (isQASignoffApproved(plan.qa_signoff as Record<string, unknown> | undefined)) {
        return { signoff: plan.qa_signoff as Record<string, unknown>, source: planPath };
      }
    } catch {
      // Keep searching other paths.
    }
  }
  if (!hasCompletedPlan) return null;
  for (const planPath of planPaths) {
    const signoff = readApprovedQASignoffFromReportSync(path.dirname(planPath));
    if (signoff) {
      return { signoff, source: path.join(path.dirname(planPath), AUTO_BUILD_PATHS.QA_REPORT) };
    }
  }
  return null;
}

export function persistApprovedQASignoffToPlansSync(
  planPaths: string[],
  signoff: Record<string, unknown>,
  projectId?: string,
  source = 'qa-report-recovery'
): boolean {
  let persisted = false;
  const now = new Date().toISOString();
  const normalizedSignoff = {
    ...signoff,
    status: 'approved',
    issues_found: Array.isArray(signoff.issues_found) ? signoff.issues_found : [],
    timestamp: signoff.timestamp || now,
    source: signoff.source || source,
  };

  for (const planPath of planPaths) {
    try {
      const content = safeReadFileSync(planPath);
      if (!content) continue;
      const plan = safeParseJson<Record<string, unknown>>(content);
      if (!plan) continue;
      const { totalCount, completedCount } = checkSubtasksCompletion(plan);
      if (totalCount === 0 || completedCount < totalCount) continue;

      plan.qa_signoff = normalizedSignoff;
      plan.status = 'human_review';
      plan.planStatus = 'review';
      plan.reviewReason = 'completed';
      plan.xstateState = 'human_review';
      plan.executionPhase = 'complete';
      plan.lastEvent = { type: 'QA_PASSED', timestamp: now, source };
      plan.updated_at = now;
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      persisted = true;
    } catch (error) {
      console.warn(`[plan-file-utils] Could not persist QA approval recovery to ${planPath}:`, error);
    }
  }

  if (persisted && projectId) projectStore.invalidateTasksCache(projectId);
  return persisted;
}

export function recoverApprovedQASignoffForSpec(project: Project, specId: string, source = 'qa-report-recovery'): boolean {
  const planPaths = getPlanPathsForSpec(project, specId).filter((planPath) => existsSync(planPath));
  if (planPaths.length === 0) return false;
  const evidence = getApprovedQASignoffEvidence(project, specId, planPaths);
  if (!evidence || !isQASignoffApproved(evidence.signoff)) return false;
  const persisted = persistApprovedQASignoffToPlansSync(planPaths, evidence.signoff, project.id, source);
  if (persisted) {
    console.warn(`[plan-file-utils] Recovered QA approval for ${specId} from ${evidence.source}`);
  }
  return persisted;
}

function getNonAutoClaudeRepoState(projectDir: string): string {
  try {
    return execFileSync(getToolPath('git'), ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).auto-claude'], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
    }).trim();
  } catch {
    return '';
  }
}

export async function repairFalseCompletedSubtasks(
  planPath: string,
  projectPath: string,
  specId: string,
  projectId?: string
): Promise<{ success: boolean; resetCount: number }> {
  return withPlanLock(planPath, async () => {
    try {
      const content = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, unknown>>(content);
      if (!plan) return { success: false, resetCount: 0 };

      const { allSubtasks, completedCount, totalCount } = checkSubtasksCompletion(plan);
      if (totalCount === 0 || completedCount === 0) return { success: true, resetCount: 0 };
      if (isQASignoffApproved(plan.qa_signoff as Record<string, unknown> | undefined) || plan.status === 'done' || plan.status === 'pr_created') {
        return { success: true, resetCount: 0 };
      }

      const worktreePath = findTaskWorktree(projectPath, specId);
      const executionPath = worktreePath || projectPath;
      const repoState = getNonAutoClaudeRepoState(executionPath);
      const failedOrReviewError = plan.status === 'error'
        || plan.reviewReason === 'errors'
        || plan.executionPhase === 'failed'
        || /^QA_/.test((plan.lastEvent as { type?: string } | undefined)?.type || '');
      if (repoState.length > 0 || !failedOrReviewError && plan.status !== 'in_progress') {
        return { success: true, resetCount: 0 };
      }

      let resetCount = 0;
      for (const subtask of allSubtasks) {
        if (subtask.status === 'completed') {
          subtask.status = 'pending';
          subtask.started_at = null;
          subtask.completed_at = null;
          subtask.last_error = 'Recovered: prior completion had no non-.auto-claude repository changes.';
          resetCount++;
        }
      }
      if (resetCount === 0) return { success: true, resetCount: 0 };

      plan.status = 'in_progress';
      plan.planStatus = 'in_progress';
      plan.xstateState = 'coding';
      plan.executionPhase = 'coding';
      delete plan.reviewReason;
      plan.recoveryNote = `Reset ${resetCount} completed subtask(s) with no repository evidence at ${new Date().toISOString()}`;
      plan.updated_at = new Date().toISOString();
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      if (projectId) projectStore.invalidateTasksCache(projectId);
      console.warn(`[plan-file-utils] Repaired ${resetCount} false completed subtask(s) in ${planPath}`);
      return { success: true, resetCount };
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] Could not repair false completed subtasks at ${planPath}:`, err);
      }
      return { success: false, resetCount: 0 };
    }
  });
}

export async function repairFalseCompletedSubtasksForSpec(project: Project, specId: string): Promise<number> {
  let totalReset = 0;
  for (const planPath of getPlanPathsForSpec(project, specId)) {
    if (!existsSync(planPath)) continue;
    const result = await repairFalseCompletedSubtasks(planPath, project.path, specId, project.id);
    if (result.success) totalReset += result.resetCount;
  }
  return totalReset;
}

export function taskNeedsQaResume(project: Project, specId: string): boolean {
  try {
    const planPath = path.join(project.path, getSpecsDir(project.autoBuildPath), specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    const content = safeReadFileSync(planPath);
    if (!content) return false;
    const plan = safeParseJson<Record<string, unknown>>(content);
    if (!plan) return false;
    const { allCompleted, totalCount } = checkSubtasksCompletion(plan);
    const qaApproved = isQASignoffApproved(plan.qa_signoff as Record<string, unknown> | undefined);
    return totalCount > 0 && allCompleted && !qaApproved && plan.status !== 'done' && plan.status !== 'pr_created';
  } catch {
    return false;
  }
}

export function persistSpecQaReviewStateSync(project: Project, specId: string): boolean {
  let persisted = false;
  for (const planPath of getPlanPathsForSpec(project, specId)) {
    if (!existsSync(planPath)) continue;
    persisted = persistPlanStatusAndReasonSync(planPath, 'ai_review', undefined, project.id, 'qa_review', 'qa_review') || persisted;
  }
  return persisted;
}

export function updatePlanAfterAppMerge(planPath: string, status: TaskStatus, planStatus: string, commitSha?: string): void {
  try {
    const content = safeReadFileSync(planPath);
    if (!content) return;
    const plan = safeParseJson<Record<string, unknown>>(content);
    if (!plan) return;
    const doneGuard = status === 'done' || status === 'pr_created'
      ? doneStatusHasIncompleteSubtasks(plan)
      : { incomplete: false, completedCount: 0, totalCount: 0 };
    if (doneGuard.incomplete) {
      plan.status = 'in_progress';
      plan.planStatus = 'in_progress';
      plan.xstateState = 'coding';
      plan.executionPhase = 'coding';
      delete plan.reviewReason;
      plan.recoveryNote = `App merge attempted ${status}, but only ${doneGuard.completedCount}/${doneGuard.totalCount} subtasks were completed; continuing implementation.`;
    } else {
      plan.status = status;
      plan.planStatus = planStatus;
      plan.xstateState = status;
      plan.executionPhase = 'complete';
      delete plan.reviewReason;
      if (status === 'done' && Array.isArray(plan.phases)) {
        for (const phase of plan.phases as Array<{ status?: string; subtasks?: Array<{ status?: string }> }>) {
          if (Array.isArray(phase.subtasks) && phase.subtasks.length > 0 && phase.subtasks.every((subtask) => subtask.status === 'completed')) {
            phase.status = 'completed';
          }
        }
      }
    }
    plan.mergedAt = new Date().toISOString();
    if (commitSha) plan.mergeCommit = commitSha;
    plan.updated_at = new Date().toISOString();
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
  } catch (err) {
    console.warn(`[plan-file-utils] Could not update plan after app merge at ${planPath}:`, err);
  }
}

/**
 * Check if a task has a valid implementation plan with subtasks.
 * A plan is considered valid if it has at least one subtask across all phases.
 *
 * @param project - The project containing the task
 * @param task - The task to check
 * @returns true if the task has a valid plan with subtasks, false otherwise
 */
export function hasPlanWithSubtasks(project: Project, task: Task): boolean {
  try {
    const planPath = getPlanPath(project, task);
    const planContent = readFileSync(planPath, 'utf-8');
    if (!planContent) {
      return false;
    }

    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) return false;
    // A plan exists if it has phases with subtasks (totalCount > 0)
    const phases = plan.phases as Array<{ subtasks?: Array<unknown> }> | undefined;
    const totalCount = phases?.flatMap(p => p.subtasks || []).length || 0;
    return totalCount > 0;
  } catch {
    // File doesn't exist or is malformed
    return false;
  }
}
