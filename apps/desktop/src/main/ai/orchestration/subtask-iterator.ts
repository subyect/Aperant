/**
 * Subtask Iterator
 * ================
 *
 * See apps/desktop/src/main/ai/orchestration/subtask-iterator.ts for the TypeScript implementation.
 * Reads implementation_plan.json, finds the next pending subtask, invokes
 * the coder agent session, and tracks completion/retry/stuck state.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeParseJson } from '../../utils/json-repair';
import type { ExtractedInsights, InsightExtractionConfig } from '../runners/insight-extractor';
import { extractSessionInsights } from '../runners/insight-extractor';
import { isRateLimitError } from '../session/error-classifier';
import type { SessionResult } from '../session/types';
import { cleanupStaleForegroundCommands } from '../tools/builtin/bash-process-tracker';
import type { SubtaskInfo } from './build-orchestrator';
import {
  RATE_LIMIT_PAUSE_FILE,
  removePauseFile,
  writeAuthPauseFile,
  writeRateLimitPauseFile,
  waitForAuthResume,
  waitForRateLimitResume,
} from './pause-handler';

// =============================================================================
// Types
// =============================================================================

/** Configuration for the subtask iterator */
export interface SubtaskIteratorConfig {
  /** Spec directory containing implementation_plan.json */
  specDir: string;
  /** Project root directory */
  projectDir: string;
  /** Maximum retries per subtask before marking stuck */
  maxRetries: number;
  /** Delay between subtask iterations (ms) */
  autoContinueDelayMs: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /**
   * Optional fallback spec dir in the main project (worktree mode).
   * Used to check for a RESUME file when the frontend can't find the worktree.
   */
  sourceSpecDir?: string;
  /** Called when a subtask starts */
  onSubtaskStart?: (subtask: SubtaskInfo, attempt: number) => void;
  /** Run the coder session for a subtask; returns the session result */
  runSubtaskSession: (subtask: SubtaskInfo, attempt: number) => Promise<SessionResult>;
  /** Called when a subtask session completes */
  onSubtaskComplete?: (subtask: SubtaskInfo, result: SessionResult) => void;
  /** Called when a subtask is marked stuck */
  onSubtaskStuck?: (subtask: SubtaskInfo, reason: string) => void;
  /** Called when insight extraction completes for a subtask (optional). */
  onInsightsExtracted?: (subtaskId: string, insights: ExtractedInsights) => void;
  /**
   * Whether to extract insights after each successful coder session.
   * Defaults to false (opt-in to avoid extra AI calls in test scenarios).
   */
  extractInsights?: boolean;
}

/** Result of the full subtask iteration */
export interface SubtaskIteratorResult {
  /** Total subtasks processed */
  totalSubtasks: number;
  /** Number of completed subtasks */
  completedSubtasks: number;
  /** IDs of subtasks marked as stuck */
  stuckSubtasks: string[];
  /** Whether iteration was cancelled */
  cancelled: boolean;
}

/** Single subtask result for internal tracking */
export interface SubtaskResult {
  subtaskId: string;
  success: boolean;
  attempts: number;
  stuck: boolean;
  error?: string;
}

// =============================================================================
// Implementation Plan Types
// =============================================================================

interface ImplementationPlan {
  feature?: string;
  workflow_type?: string;
  phases: PlanPhase[];
}

interface PlanPhase {
  id?: string;
  phase?: number;
  name: string;
  subtasks: PlanSubtask[];
}

interface PlanSubtask {
  id: string;
  title: string;
  description: string;
  status: string;
  service?: string;
  files_to_create?: string[];
  files_to_modify?: string[];
  patterns_from?: string[];
  verification?: SubtaskInfo['verification'];
  last_error?: string;
  last_attempt_outcome?: string;
}

const RECOVERY_SUBTASK_PRIORITY = [
  'aperant-base-sync-conflict',
  'aperant-qa-report-failure',
  'aperant-human-feedback-rework',
];

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Iterate through all pending subtasks in the implementation plan.
 *
 * Replaces the inner subtask loop in agents/coder.py:
 * - Reads implementation_plan.json for the next pending subtask
 * - Invokes the coder agent session
 * - Re-reads the plan after each session (the agent updates subtask status)
 * - Tracks retry counts and marks subtasks as stuck after max retries
 * - Continues until all subtasks complete or build is stuck
 */
export async function iterateSubtasks(
  config: SubtaskIteratorConfig,
): Promise<SubtaskIteratorResult> {
  const attemptCounts = new Map<string, number>();
  const stuckSubtasks: string[] = [];
  let completedSubtasks = 0;
  let totalSubtasks = 0;

  while (true) {
    // Check cancellation
    if (config.abortSignal?.aborted) {
      return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
    }

    // Load the plan and find next pending subtask
    const plan = await loadImplementationPlan(config.specDir);
    if (!plan) {
      return { totalSubtasks: 0, completedSubtasks: 0, stuckSubtasks, cancelled: false };
    }

    // Count totals
    totalSubtasks = countTotalSubtasks(plan);
    completedSubtasks = countCompletedSubtasks(plan);

    // Find next subtask
    const next = getNextPendingSubtask(plan, stuckSubtasks);
    if (!next) {
      // All subtasks completed or stuck
      break;
    }

    const { subtask, phaseName } = next;
    const subtaskInfo: SubtaskInfo = {
      id: subtask.id,
      description: subtask.description,
      phaseName,
      service: subtask.service,
      filesToCreate: subtask.files_to_create,
      filesToModify: subtask.files_to_modify,
      patternsFrom: subtask.patterns_from,
      verification: subtask.verification,
      status: subtask.status,
      lastError: subtask.last_error,
      lastAttemptOutcome: subtask.last_attempt_outcome,
    };

    // Track attempts
    const currentAttempt = (attemptCounts.get(subtask.id) ?? 0) + 1;
    attemptCounts.set(subtask.id, currentAttempt);

    // Check if stuck. Soft retry states get a larger budget because they are
    // usually recoverable provider/plan-marker failures, not implementation
    // dead ends.
    const maxAttemptsForSubtask = shouldKeepRetryingSubtask(subtask)
      ? config.maxRetries * 3
      : config.maxRetries;
    if (currentAttempt > maxAttemptsForSubtask) {
      stuckSubtasks.push(subtask.id);
      config.onSubtaskStuck?.(
        subtaskInfo,
        `Exceeded max retries (${maxAttemptsForSubtask})`,
      );
      continue;
    }

    // Notify start
    config.onSubtaskStart?.(subtaskInfo, currentAttempt);

    await cleanupStaleForegroundCommands(config.specDir);

    // Run the session
    const result = await config.runSubtaskSession(subtaskInfo, currentAttempt);

    // Notify complete
    config.onSubtaskComplete?.(subtaskInfo, result);

    // Handle outcomes
    if (result.outcome === 'cancelled') {
      return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
    }

    if (isRateLimitedSessionResult(result)) {
      // Write pause file so the frontend can show a countdown
      const errorMessage = result.error?.message ?? 'Rate limit reached';
      writeRateLimitPauseFile(config.specDir, errorMessage, null);
      if (config.sourceSpecDir && config.sourceSpecDir !== config.specDir) {
        try {
          writeRateLimitPauseFile(config.sourceSpecDir, errorMessage, null);
        } catch {
          // The worktree pause file is authoritative for the running worker.
        }
      }

      // Wait for the rate limit to reset (or user to resume early)
      await waitForRateLimitResume(
        config.specDir,
        MAX_RATE_LIMIT_WAIT_MS_DEFAULT,
        config.sourceSpecDir,
        config.abortSignal,
      );

      // Re-check abort after waiting
      if (config.abortSignal?.aborted) {
        return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
      }

      if (config.sourceSpecDir && config.sourceSpecDir !== config.specDir) {
        removePauseFile(config.sourceSpecDir, RATE_LIMIT_PAUSE_FILE);
      }

      // Continue the loop — subtask will be retried
      continue;
    }

    if (result.outcome === 'auth_failure') {
      // Write pause file so the frontend can show a re-auth prompt
      const errorMessage = result.error?.message ?? 'Authentication failed';
      writeAuthPauseFile(config.specDir, errorMessage);

      // Wait for user to re-authenticate
      await waitForAuthResume(config.specDir, config.sourceSpecDir, config.abortSignal);

      // Re-check abort after waiting
      if (config.abortSignal?.aborted) {
        return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: true };
      }

      // Continue — subtask will be retried with fresh auth
      continue;
    }

    const completionState = await readSubtaskCompletionState(config.specDir, subtask.id);
    const subtaskCompleted = completionState.status === 'completed';

    if (!subtaskCompleted) {
      const reason = buildRetryReason(result, completionState.status);
      await markSubtaskRetryRequired(config.specDir, subtask.id, reason, result.outcome);
    }

    // Re-stamp executionPhase on the worktree plan after the coder session.
    // The coder model's Edit/Write calls can overwrite executionPhase with a
    // stale value (read before persistPlanPhaseSync ran). Since the model is
    // no longer writing, we can safely correct it here.
    await restampExecutionPhase(config.specDir, 'coding');

    // Sync updated phases to main project plan (worktree mode).
    // This keeps the main plan current during execution, not just on exit.
    if (config.sourceSpecDir) {
      await syncPhasesToMain(config.specDir, config.sourceSpecDir);
    }

    // Extract insights only when the plan itself proves completion. A finished
    // session, max_steps, or context_window is not proof that the subtask is done.
    if (subtaskCompleted && config.extractInsights) {
      extractInsightsAfterSession(config, subtask, result).then((insights) => {
        if (insights) config.onInsightsExtracted?.(subtask.id, insights);
      }).catch(() => { /* insight extraction is non-blocking */ });
    }

    // Delay before next iteration
    if (config.autoContinueDelayMs > 0) {
      await delay(config.autoContinueDelayMs, config.abortSignal);
    }
  }

  return { totalSubtasks, completedSubtasks, stuckSubtasks, cancelled: false };
}

// =============================================================================
// Post-Session Processing
// =============================================================================

async function readSubtaskCompletionState(
  specDir: string,
  subtaskId: string,
): Promise<{ found: boolean; status?: string }> {
  const planPath = join(specDir, 'implementation_plan.json');
  try {
    const raw = await readFile(planPath, 'utf-8');
    const plan = safeParseJson<ImplementationPlan>(raw);
    if (!plan) return { found: false }; // JSON corrupt beyond repair

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const withLegacyId = subtask as PlanSubtask & { subtask_id?: string };
        const id = subtask.id ?? withLegacyId.subtask_id;
        if (id === subtaskId) {
          return { found: true, status: subtask.status };
        }
      }
    }

    return { found: false };
  } catch {
    return { found: false };
  }
}

function buildRetryReason(
  result: SessionResult,
  currentStatus: string | undefined,
): string {
  if (result.outcome === 'completed') {
    return `Agent session ended without marking the subtask completed in implementation_plan.json (current status: ${currentStatus ?? 'missing'}). Retrying until the plan proves completion.`;
  }
  if (result.outcome === 'max_steps') {
    return 'Agent hit the max step limit before the subtask was marked completed. Retrying the subtask.';
  }
  if (result.outcome === 'context_window') {
    return 'Agent hit the context window before the subtask was marked completed. Retrying the subtask.';
  }
  return result.error?.message ?? `Agent session ended with outcome "${result.outcome}". Retrying the subtask.`;
}

function isRateLimitedSessionResult(result: SessionResult): boolean {
  return result.outcome === 'rate_limited'
    || result.error?.code === 'rate_limited'
    || isRateLimitError(result.error?.message ?? result.error);
}

function shouldKeepRetryingSubtask(subtask: PlanSubtask): boolean {
  if (
    subtask.last_attempt_outcome === 'completed' &&
    subtask.last_error?.includes('without marking the subtask completed')
  ) {
    return true;
  }

  if (subtask.last_error?.includes('Stream inactivity timeout')) {
    return true;
  }

  return false;
}

/**
 * Keep unfinished subtasks retryable after a session ends.
 *
 * A session outcome is not completion proof. Only implementation_plan.json with
 * the specific subtask marked completed can advance the loop.
 */
async function markSubtaskRetryRequired(
  specDir: string,
  subtaskId: string,
  reason: string,
  outcome: SessionResult['outcome'],
): Promise<void> {
  const planPath = join(specDir, 'implementation_plan.json');
  try {
    const raw = await readFile(planPath, 'utf-8');
    const plan = safeParseJson<ImplementationPlan>(raw);
    if (!plan) return;
    let updated = false;

    for (const phase of plan.phases) {
      for (const subtask of phase.subtasks) {
        const withLegacyId = subtask as PlanSubtask & {
          subtask_id?: string;
          last_error?: string;
          last_attempt_outcome?: string;
          last_attempt_at?: string;
        };
        const id = subtask.id ?? withLegacyId.subtask_id;
        if (id !== subtaskId || subtask.status === 'completed') continue;

        if (!subtask.id && withLegacyId.subtask_id) {
          subtask.id = withLegacyId.subtask_id;
        }
        subtask.status = 'pending';
        withLegacyId.last_error = reason;
        withLegacyId.last_attempt_outcome = outcome;
        withLegacyId.last_attempt_at = new Date().toISOString();
        updated = true;
      }
    }

    if (updated) {
      await writeFile(planPath, JSON.stringify(plan, null, 2));
    }
  } catch {
    // Non-fatal: if we can't update the plan the loop will retry or mark stuck.
  }
}

/**
 * Re-stamp executionPhase on the plan file after a coder session.
 *
 * During a coder session, the model reads implementation_plan.json, edits
 * subtask statuses, and writes the file back. If the model read the plan
 * before persistPlanPhaseSync set executionPhase to 'coding', the model's
 * write overwrites executionPhase with the stale value (e.g., 'planning').
 *
 * This function runs AFTER the session ends (no more model writes) and
 * corrects executionPhase to the actual current phase.
 *
 * @internal Exported for unit testing only.
 */
export async function restampExecutionPhase(
  specDir: string,
  phase: string,
): Promise<void> {
  const planPath = join(specDir, 'implementation_plan.json');
  try {
    const raw = await readFile(planPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(raw);
    if (!plan) {
      console.warn(`[restampExecutionPhase] Could not parse implementation_plan.json in ${specDir} — skipping restamp`);
      return;
    }

    if (plan.executionPhase !== phase) {
      plan.executionPhase = phase;
      plan.updated_at = new Date().toISOString();
      await writeFile(planPath, JSON.stringify(plan, null, 2));
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Sync phases from the worktree plan to the main project plan.
 * Keeps the main plan's subtask statuses up-to-date during execution,
 * not just on process exit. Non-fatal: skip silently on any error.
 */
async function syncPhasesToMain(
  worktreeSpecDir: string,
  mainSpecDir: string,
): Promise<void> {
  try {
    const worktreePlanPath = join(worktreeSpecDir, 'implementation_plan.json');
    const mainPlanPath = join(mainSpecDir, 'implementation_plan.json');

    const worktreeRaw = await readFile(worktreePlanPath, 'utf-8');
    const worktreePlan = safeParseJson<ImplementationPlan>(worktreeRaw);
    if (!worktreePlan?.phases) return;

    const mainRaw = await readFile(mainPlanPath, 'utf-8');
    const mainPlan = safeParseJson<Record<string, unknown>>(mainRaw);
    if (!mainPlan) return;

    mainPlan.phases = worktreePlan.phases;
    mainPlan.updated_at = new Date().toISOString();

    await writeFile(mainPlanPath, JSON.stringify(mainPlan, null, 2));
  } catch (err) {
    // Non-fatal: the exit handler will do a final definitive sync.
    // Log so we can diagnose subtask-status-not-updating issues.
    console.warn(
      `[syncPhasesToMain] Failed to sync phases from ${worktreeSpecDir} to ${mainSpecDir}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// =============================================================================
// Plan Queries
// =============================================================================

/**
 * Load and parse implementation_plan.json.
 */
async function loadImplementationPlan(
  specDir: string,
): Promise<ImplementationPlan | null> {
  const planPath = join(specDir, 'implementation_plan.json');
  try {
    const raw = await readFile(planPath, 'utf-8');
    return safeParseJson<ImplementationPlan>(raw);
  } catch {
    return null;
  }
}

/**
 * Get the next pending subtask from the plan.
 * Skips subtasks that are completed, in_progress (may be worked on by another session),
 * or marked as stuck.
 */
function getNextPendingSubtask(
  plan: ImplementationPlan,
  stuckSubtaskIds: string[],
): { subtask: PlanSubtask; phaseName: string } | null {
  for (const recoverySubtaskId of RECOVERY_SUBTASK_PRIORITY) {
    const recoverySubtask = findRunnableSubtask(
      plan,
      stuckSubtaskIds,
      (subtask) => subtask.id === recoverySubtaskId,
    );
    if (recoverySubtask) return recoverySubtask;
  }

  return findRunnableSubtask(plan, stuckSubtaskIds);
}

function findRunnableSubtask(
  plan: ImplementationPlan,
  stuckSubtaskIds: string[],
  predicate: (subtask: PlanSubtask) => boolean = () => true,
): { subtask: PlanSubtask; phaseName: string } | null {
  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (!predicate(subtask)) continue;
      if (
        subtask.status === 'pending' &&
        !stuckSubtaskIds.includes(subtask.id)
      ) {
        return { subtask, phaseName: phase.name };
      }
      // Also pick up in_progress subtasks (may need retry after crash)
      if (
        subtask.status === 'in_progress' &&
        !stuckSubtaskIds.includes(subtask.id)
      ) {
        return { subtask, phaseName: phase.name };
      }
    }
  }
  return null;
}

/**
 * Count total subtasks across all phases.
 */
function countTotalSubtasks(plan: ImplementationPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    count += phase.subtasks.length;
  }
  return count;
}

/**
 * Count completed subtasks across all phases.
 */
function countCompletedSubtasks(plan: ImplementationPlan): number {
  let count = 0;
  for (const phase of plan.phases) {
    for (const subtask of phase.subtasks) {
      if (subtask.status === 'completed') {
        count++;
      }
    }
  }
  return count;
}

// =============================================================================
// Post-session Insight Extraction
// =============================================================================

/** Default max wait for a rate-limit reset (2 hours), matching Python constant. */
const MAX_RATE_LIMIT_WAIT_MS_DEFAULT = 7_200_000;

/**
 * Run insight extraction for a completed subtask session.
 *
 * This is fire-and-forget — it never blocks the build loop.
 * Returns null on any error so the caller can safely ignore failures.
 */
async function extractInsightsAfterSession(
  config: SubtaskIteratorConfig,
  subtask: PlanSubtask,
  result: SessionResult,
): Promise<ExtractedInsights | null> {
  try {
    const insightConfig: InsightExtractionConfig = {
      subtaskId: subtask.id,
      subtaskDescription: subtask.description,
      sessionNum: 1,
      success: result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window',
      diff: '',           // Diff gathering requires git; left empty for now
      changedFiles: [],   // Populated by future git integration
      commitMessages: '',
      attemptHistory: [],
    };

    return await extractSessionInsights(insightConfig);
  } catch {
    return null;
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Delay with abort signal support.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
