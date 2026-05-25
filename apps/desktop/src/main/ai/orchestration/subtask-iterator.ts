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
import { preserveCompletedSubtasks } from '../../task-plan-guards';
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
  notes?: string;
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
      notes: subtask.notes,
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
      ? config.maxRetries * 12
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
    let subtaskCompleted = completionState.status === 'completed';
    let retryReasonWritten = false;

    if (subtaskCompleted) {
      const latestBashFailure = buildLatestBashFailureRetryReason(result);
      if (latestBashFailure) {
        subtaskCompleted = false;
        await markSubtaskRetryRequired(
          config.specDir,
          subtask.id,
          `Subtask was marked completed, but the latest Bash verification failed.\n\n${latestBashFailure}`,
          result.outcome,
          true,
        );
        retryReasonWritten = true;
      }
    }

    if (!subtaskCompleted && subtask.id === 'aperant-qa-report-failure') {
      const verificationNote = buildSuccessfulQaRecoveryVerificationNote(result);
      if (verificationNote) {
        await markSubtaskCompletedByVerification(config.specDir, subtask.id, verificationNote);
        subtaskCompleted = true;
      }
    }

    if (!subtaskCompleted && subtask.id === 'aperant-base-sync-conflict') {
      const verificationNote = buildSuccessfulBaseSyncRecoveryVerificationNote(result);
      if (verificationNote) {
        await markSubtaskCompletedByVerification(config.specDir, subtask.id, verificationNote);
        subtaskCompleted = true;
      }
    }

    if (!subtaskCompleted) {
      const verificationNote = buildSuccessfulSubtaskVerificationNote(result);
      if (verificationNote) {
        await markSubtaskCompletedByVerification(config.specDir, subtask.id, verificationNote);
        subtaskCompleted = true;
      }
    }

    if (!subtaskCompleted && !retryReasonWritten) {
      const reason = buildRetryReason(result, completionState.status, subtask);
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
  subtask?: PlanSubtask,
): string {
  const bashFailure = buildBashFailureRetryReason(result);
  if (bashFailure) {
    return bashFailure;
  }

  if (result.outcome === 'completed') {
    const finalMessage = getLastAssistantMessage(result);
    const persistedFailureContext = getPersistedVerifierFailureContext(subtask);
    const verifierFailureContext = [finalMessage, persistedFailureContext].filter(Boolean).join('\n\n');
    if (verifierFailureContext && looksLikeRepoLocalVerifierFailureSummary(verifierFailureContext)) {
      return (
        `Bash command failed during the attempt or the assistant reported a repo-local verifier failure, ` +
        `but the subtask was not completed in implementation_plan.json (current status: ${currentStatus ?? 'missing'}).\n` +
        `Do not stop with another blocker summary. Fix the repo-local imports, package exports, failed assertions, generated artifacts, or test harness code needed by the required verifier, then rerun targeted verification before marking complete. ` +
        `Do not classify failures inside this repository or workspace packages as outside the current task scope.\n\n` +
        `Reported failure summary:\n${compactForPlan(verifierFailureContext, 1_600)}`
      );
    }
    const falseCompletionWarning = finalMessage && looksLikeFalseCompletionClaim(finalMessage)
      ? (
        `\n\nWARNING: The previous assistant message claimed this subtask was completed, tests passed, or the plan was updated, ` +
        `but implementation_plan.json still shows the subtask as ${currentStatus ?? 'missing'}. ` +
        `Do not repeat that claim. Treat the prior summary as untrusted until you verify the actual plan file and shell output.`
      )
      : '';
    return (
      `Agent session ended without marking the subtask completed in implementation_plan.json (current status: ${currentStatus ?? 'missing'}). ` +
      `Retrying until the plan proves completion.` +
      falseCompletionWarning +
      (finalMessage ? `\n\nLast assistant message:\n${compactForPlan(finalMessage, 1_200)}` : '')
    );
  }
  if (result.outcome === 'max_steps') {
    return 'Agent hit the max step limit before the subtask was marked completed. Retrying the subtask.';
  }
  if (result.outcome === 'context_window') {
    return 'Agent hit the context window before the subtask was marked completed. Retrying the subtask.';
  }
  return result.error?.message ?? `Agent session ended with outcome "${result.outcome}". Retrying the subtask.`;
}

function getPersistedVerifierFailureContext(subtask?: PlanSubtask): string | null {
  const parts = [
    typeof subtask?.notes === 'string' ? subtask.notes : '',
    typeof subtask?.last_error === 'string' ? subtask.last_error : '',
  ].map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function looksLikeFalseCompletionClaim(message: string): boolean {
  return /\b(marked|updated|set)\b[\s\S]{0,80}\b(completed|complete|implementation_plan\.json|subtask)\b/i.test(message)
    || /\b(test|tests|verification|verifier|route smoke|smoke)\b[\s\S]{0,80}\b(pass|passed|passes|green|success|successful)\b/i.test(message)
    || /\bimplemented and verified\b/i.test(message)
    || /\bif you want\b/i.test(message);
}

function looksLikeRepoLocalVerifierFailureSummary(message: string): boolean {
  const reportsFailure = /\b(fail|failed|failing|failure|blocker|cannot mark|can't mark|did not mark|does not pass|do not pass|not complete yet)\b/i.test(message);
  if (!reportsFailure) return false;

  return /Cannot find module|Module not found|Failed to resolve import|Does the file exist\?|unresolved(?:\s+[`'"]?@?[\w/-]+| imports?)?|missing (?:query )?modules?|missing workspace packages?|dist missing|package[-\s]resolution|module[-\s]resolution|import[-\s]resolution|startup 500s?|failed suites?|failed tests?|assertion failure|Exit code:\s*[1-9]\d*/i.test(message);
}

function getLastAssistantMessage(result: SessionResult): string | null {
  const messages = result.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const content = typeof message.content === 'string'
      ? message.content.trim()
      : '';
    if (content) return content;
  }
  return null;
}

function buildBashFailureRetryReason(result: SessionResult): string | null {
  const bashResults = (result.toolResults ?? [])
    .filter((toolResult) => toolResult.toolName === 'Bash');

  for (let i = bashResults.length - 1; i >= 0; i--) {
    const toolResult = bashResults[i];
    if (!isFailedBashOutput(toolResult.result)) continue;
    return formatBashFailureRetryReason(toolResult);
  }

  return null;
}

function buildLatestBashFailureRetryReason(result: SessionResult): string | null {
  const bashResults = (result.toolResults ?? [])
    .filter((toolResult) => toolResult.toolName === 'Bash');
  const latest = bashResults[bashResults.length - 1];
  if (!latest || !isFailedBashOutput(latest.result)) return null;
  return formatBashFailureRetryReason(latest);
}

function buildSuccessfulQaRecoveryVerificationNote(result: SessionResult): string | null {
  const bashResults = (result.toolResults ?? [])
    .filter((toolResult) => toolResult.toolName === 'Bash');

  for (let i = bashResults.length - 1; i >= 0; i--) {
    const toolResult = bashResults[i];
    const command = typeof toolResult.args?.command === 'string'
      ? toolResult.args.command
      : '';
    const output = toolResult.result;
    if (!/console-routes\.spec\.ts/.test(command)) continue;
    if (isFailedBashOutput(output)) continue;
    if (!/\b\d+\s+passed\b/i.test(output)) continue;

    return (
      `Auto-completed QA recovery after successful route smoke verification.\n` +
      `Command: ${command}\n` +
      `Result: ${compactForPlan(output, 1_200)}`
    );
  }

  for (let i = bashResults.length - 1; i >= 0; i--) {
    const toolResult = bashResults[i];
    const command = typeof toolResult.args?.command === 'string'
      ? toolResult.args.command
      : '';
    const output = toolResult.result;
    if (!/\b(test|vitest|playwright)\b/i.test(command)) continue;
    if (isFailedBashOutput(output)) continue;
    if (/\bfailed\b/i.test(output)) continue;
    if (!hasPassingTestEvidence(output)) continue;

    return (
      `Auto-completed QA recovery after successful test verification.\n` +
      `Command: ${command}\n` +
      `Result: ${compactForPlan(output, 1_200)}`
    );
  }

  return null;
}

function hasPassingTestEvidence(output: string): boolean {
  return /\b\d+\s+passed\b/i.test(output)
    || /Test Files\s+\d+\s+passed/i.test(output)
    || /Tests\s+\d+\s+passed/i.test(output);
}

function buildSuccessfulBaseSyncRecoveryVerificationNote(result: SessionResult): string | null {
  const bashResults = (result.toolResults ?? [])
    .filter((toolResult) => toolResult.toolName === 'Bash');

  for (let i = bashResults.length - 1; i >= 0; i--) {
    const toolResult = bashResults[i];
    const command = typeof toolResult.args?.command === 'string'
      ? toolResult.args.command
      : '';
    const output = toolResult.result;

    if (!/git\s+diff\s+--name-only\s+--diff-filter=U/.test(command)) continue;
    if (isFailedBashOutput(output)) continue;
    if (hasUnmergedFileEvidence(output)) continue;

    return (
      `Auto-completed base sync recovery after git reported no unmerged files.\n` +
      `Command: ${command}\n` +
      `Result: ${compactForPlan(output, 1_200)}`
    );
  }

  return null;
}

function buildSuccessfulSubtaskVerificationNote(result: SessionResult): string | null {
  if (result.outcome !== 'completed') return null;
  const finalMessage = getLastAssistantMessage(result);
  if (!finalMessage || !looksLikeFalseCompletionClaim(finalMessage)) return null;

  const verifier = findLatestPassingVerifier(result);
  if (!verifier) return null;

  return (
    `Auto-completed subtask after the agent reported completion and the latest verifier passed.\n` +
    `Command: ${verifier.command}\n` +
    `Result: ${compactForPlan(verifier.output, 1_200)}`
  );
}

function findLatestPassingVerifier(result: SessionResult): { command: string; output: string } | null {
  const bashResults = (result.toolResults ?? [])
    .filter((toolResult) => toolResult.toolName === 'Bash');

  for (let i = bashResults.length - 1; i >= 0; i--) {
    const toolResult = bashResults[i];
    const command = typeof toolResult.args?.command === 'string'
      ? toolResult.args.command
      : '';
    const output = toolResult.result;
    if (!looksLikeVerifierCommand(command, output)) continue;
    if (isFailedBashOutput(output)) return null;
    if (/\bfailed\b/i.test(output) && !/\b0\s+failed\b/i.test(output)) return null;
    return { command, output };
  }

  return null;
}

function looksLikeVerifierCommand(command: string, output: string): boolean {
  if (hasPassingTestEvidence(output)) return true;
  return /\b(test|vitest|playwright|typecheck|tsc|lint|build)\b/i.test(command);
}

function hasUnmergedFileEvidence(output: string): boolean {
  const normalized = output.replace(/\r\n/g, '\n');
  if (/^UU\s+\S+/m.test(normalized)) return true;
  if (/^AA\s+\S+/m.test(normalized)) return true;
  if (/^DD\s+\S+/m.test(normalized)) return true;
  if (/^AU\s+\S+/m.test(normalized)) return true;
  if (/^UA\s+\S+/m.test(normalized)) return true;
  if (/^DU\s+\S+/m.test(normalized)) return true;
  if (/^UD\s+\S+/m.test(normalized)) return true;
  if (/^U\s+\S+/m.test(normalized)) return true;
  if (/^CONFLICT\b/m.test(normalized)) return true;
  if (/^<<<<<<<\s/m.test(normalized)) return true;
  if (/^=======$/m.test(normalized)) return true;
  if (/^>>>>>>>\s/m.test(normalized)) return true;

  return normalized
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || isKnownEmptyConflictCheckLine(trimmed)) return false;
      if (/^[ MADRC?!]{2}\s+\S+/.test(line)) return false;
      return /^[\w./-]+\.[\w.-]+$/.test(trimmed) || trimmed.includes('/');
    });
}

function isKnownEmptyConflictCheckLine(line: string): boolean {
  return line === 'Exit code: 0'
    || line.startsWith('STDOUT:')
    || line.startsWith('STDERR:')
    || line.startsWith('$ ')
    || line.startsWith('PWD=')
    || line.startsWith('/Users/')
    || line.includes('git diff --name-only --diff-filter=U')
    || /no unmerged files/i.test(line)
    || /no conflicts/i.test(line)
    || /nothing to commit/i.test(line);
}

function formatBashFailureRetryReason(toolResult: NonNullable<SessionResult['toolResults']>[number]): string {
  const output = toolResult.result;
  const command = typeof toolResult.args?.command === 'string'
    ? toolResult.args.command
    : '(command unavailable)';
  const outputSnippet = compactForPlan(output, 1_600);

  if (output.includes('Command produced no output for')) {
    return (
      `Bash verification command stalled without output and was killed: \`${command}\`.\n` +
      `Tool output:\n${outputSnippet}\n\n` +
      `Do not rerun the same command unchanged. Use a narrower or more verbose command, inspect the relevant logs, and fix the blocker before marking this subtask completed.`
    );
  }

  if (output.includes('Command is likely to run silently')) {
    return (
      `Bash verification command was rejected because it is likely to stall without output: \`${command}\`.\n` +
      `Tool output:\n${outputSnippet}\n\n` +
      `Use the suggested verbose or narrower verifier instead of rerunning the same command unchanged.`
    );
  }

  if (output.includes('Command timed out after')) {
    return (
      `Bash verification command timed out: \`${command}\`.\n` +
      `Tool output:\n${outputSnippet}\n\n` +
      `Do not mark this subtask completed until the timeout is explained or the verification is replaced with a targeted passing check.`
    );
  }

  return (
    `Bash command failed during the attempt: \`${command}\`.\n` +
    `Tool output:\n${outputSnippet}\n\n` +
    `Fix the failure or run a targeted passing verification before marking this subtask completed.`
  );
}

function isFailedBashOutput(output: string): boolean {
  return /Exit code:\s*[1-9]\d*/.test(output)
    || output.includes('Command produced no output for')
    || output.includes('Command is likely to run silently')
    || output.includes('Command timed out after')
    || output.includes('Command aborted; process tree was terminated.');
}

function compactForPlan(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated — ${value.length} characters total]`;
}

function isRateLimitedSessionResult(result: SessionResult): boolean {
  return result.outcome === 'rate_limited'
    || result.error?.code === 'rate_limited'
    || isRateLimitError(result.error?.message ?? result.error);
}

function shouldKeepRetryingSubtask(subtask: PlanSubtask): boolean {
  if (
    RECOVERY_SUBTASK_PRIORITY.includes(subtask.id) &&
    (
      subtask.last_error?.includes('Bash command failed during the attempt')
      || subtask.last_error?.includes('latest Bash verification failed')
      || subtask.last_error?.includes('Bash verification command stalled')
      || subtask.last_error?.includes('Bash verification command timed out')
      || subtask.last_error?.includes('Bash verification command was rejected')
      || subtask.last_error?.includes('repo-local verifier failure')
      || subtask.last_error?.includes('Do not stop with another blocker summary')
    )
  ) {
    return true;
  }

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
  resetCompleted = false,
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
        if (id !== subtaskId || (subtask.status === 'completed' && !resetCompleted)) continue;

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

async function markSubtaskCompletedByVerification(
  specDir: string,
  subtaskId: string,
  completionNote: string,
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
          completed_at?: string;
          completion_note?: string;
          last_error?: string;
          last_attempt_outcome?: string;
          last_attempt_at?: string;
        };
        const id = subtask.id ?? withLegacyId.subtask_id;
        if (id !== subtaskId) continue;

        if (!subtask.id && withLegacyId.subtask_id) {
          subtask.id = withLegacyId.subtask_id;
        }
        subtask.status = 'completed';
        withLegacyId.completed_at = new Date().toISOString();
        withLegacyId.completion_note = completionNote;
        delete withLegacyId.last_error;
        delete withLegacyId.last_attempt_outcome;
        delete withLegacyId.last_attempt_at;
        updated = true;
      }
    }

    if (updated) {
      await writeFile(planPath, JSON.stringify(plan, null, 2));
    }
  } catch {
    // Non-fatal: if we cannot prove completion in the plan, the loop retries.
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

    const restoredWorktreeCompletions = preserveCompletedSubtasks(
      worktreePlan as unknown as Record<string, unknown>,
      mainPlan,
    );

    if (restoredWorktreeCompletions) {
      await writeFile(worktreePlanPath, JSON.stringify(worktreePlan, null, 2));
    }

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
