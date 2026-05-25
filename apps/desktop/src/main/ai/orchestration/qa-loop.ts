/**
 * QA Validation Loop
 * ==================
 *
 * See apps/desktop/src/main/ai/orchestration/qa-loop.ts for the TypeScript implementation.
 *
 * Coordinates the QA review/fix iteration cycle:
 *   1. QA Reviewer agent validates the build
 *   2. If rejected → QA Fixer agent applies fixes
 *   3. Loop back to reviewer
 *   4. Repeat until approved, max iterations, or escalation
 *
 * Enhanced with:
 * - Recurring issue detection (escalate after threshold)
 * - Consecutive error tracking (escalate after MAX_CONSECUTIVE_ERRORS)
 * - Human feedback processing (QA_FIX_REQUEST.md)
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'events';

import {
  generateEscalationReport,
  generateManualTestPlan,
  generateQAReport,
} from './qa-reports';

import type { AgentType } from '../config/agent-configs';
import type { Phase } from '../config/types';
import { QASignoffSchema, validateStructuredOutput } from '../schema';
import { safeParseJson } from '../../utils/json-repair';
import { normalizeQaFailureEvidenceContent } from '../../qa-feedback-utils';
import type { SessionResult } from '../session/types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum QA review/fix iterations before escalating to human */
const MAX_QA_ITERATIONS = 50;

/** Stop after this many consecutive errors without progress */
const MAX_CONSECUTIVE_ERRORS = 3;

/** Number of times an issue must recur before escalation */
const RECURRING_ISSUE_THRESHOLD = 3;

// =============================================================================
// Types
// =============================================================================

/** QA signoff status from implementation_plan.json */
type QAStatus = 'approved' | 'rejected' | 'fixes_applied' | 'unknown';

/** A single QA issue found during review */
export interface QAIssue {
  type?: 'critical' | 'warning';
  title: string;
  description?: string;
  location?: string;
  fix_required?: string;
}

/** Record of a single QA iteration */
export interface QAIterationRecord {
  iteration: number;
  status: 'approved' | 'rejected' | 'error';
  issues: QAIssue[];
  durationMs: number;
  timestamp: string;
}

/** Configuration for the QA loop */
export interface QALoopConfig {
  /** Spec directory path */
  specDir: string;
  /** Main project spec directory when QA runs in an isolated worktree */
  sourceSpecDir?: string;
  /** Project root directory */
  projectDir: string;
  /** CLI model override */
  cliModel?: string;
  /** CLI thinking level override */
  cliThinking?: string;
  /** Maximum iterations override (default: MAX_QA_ITERATIONS) */
  maxIterations?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Callback to generate system prompt */
  generatePrompt: (agentType: AgentType, context: QAPromptContext) => Promise<string>;
  /** Callback to run an agent session */
  runSession: (config: QASessionRunConfig) => Promise<SessionResult>;
}

/** Context passed to prompt generation */
export interface QAPromptContext {
  /** Current iteration number */
  iteration: number;
  /** Max iterations allowed */
  maxIterations: number;
  /** Whether processing human feedback */
  isHumanFeedback?: boolean;
  /** Exact human feedback from QA_FIX_REQUEST.md */
  humanFeedback?: string;
  /** Previous error context for self-correction */
  previousError?: QAErrorContext;
}

/** Error context for self-correction feedback */
interface QAErrorContext {
  errorType: string;
  errorMessage: string;
  consecutiveErrors: number;
  expectedAction: string;
}

/** Configuration passed to runSession callback */
export interface QASessionRunConfig {
  agentType: AgentType;
  phase: Phase;
  systemPrompt: string;
  specDir: string;
  projectDir: string;
  sessionNumber: number;
  abortSignal?: AbortSignal;
  cliModel?: string;
  cliThinking?: string;
}

/** Events emitted by the QA loop */
export interface QALoopEvents {
  /** QA iteration started */
  'qa-iteration-start': (iteration: number, maxIterations: number) => void;
  /** QA review completed */
  'qa-review-complete': (iteration: number, status: QAStatus, issues: QAIssue[]) => void;
  /** QA fixer started */
  'qa-fix-start': (iteration: number) => void;
  /** QA fixer completed */
  'qa-fix-complete': (iteration: number) => void;
  /** QA loop finished */
  'qa-complete': (outcome: QAOutcome) => void;
  /** Log message */
  'log': (message: string) => void;
  /** Error during QA */
  'error': (error: Error) => void;
}

/** Final QA outcome */
export interface QAOutcome {
  /** Whether QA approved the build */
  approved: boolean;
  /** Total iterations executed */
  totalIterations: number;
  /** Duration in ms */
  durationMs: number;
  /** Reason if not approved */
  reason?: 'max_iterations' | 'recurring_issues' | 'consecutive_errors' | 'cancelled' | 'error';
  /** Error message if failed */
  error?: string;
}

type HumanFeedbackProcessResult =
  | { ok: true }
  | { ok: false; reason: 'cancelled' | 'error'; message?: string };

/** QA signoff structure from implementation_plan.json */
interface QASignoff {
  status: string;
  qa_session?: number;
  tests_passed?: Record<string, string>;
  issues_found?: QAIssue[];
}

// =============================================================================
// QALoop
// =============================================================================

/**
 * Orchestrates the QA validation loop: review → fix → re-review.
 *
 * Replaces the Python `run_qa_validation_loop()` from `qa/loop.py`.
 */
export class QALoop extends EventEmitter {
  private config: QALoopConfig;
  private sessionNumber = 0;
  private aborted = false;
  private iterationHistory: QAIterationRecord[] = [];

  constructor(config: QALoopConfig) {
    super();
    this.config = config;

    config.abortSignal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  /**
   * Run the full QA validation loop.
   *
   * @returns QAOutcome indicating whether the build was approved
   */
  async run(): Promise<QAOutcome> {
    const startTime = Date.now();
    const maxIterations = this.config.maxIterations ?? MAX_QA_ITERATIONS;

    try {
      // Verify build is complete
      const buildComplete = await this.isBuildComplete();
      if (!buildComplete) {
        this.emitTyped('log', 'Build is not complete, cannot run QA validation');
        return this.outcome(false, 0, Date.now() - startTime, 'error', 'Build not complete');
      }

      // Check if already approved (unless human feedback pending)
      const hasHumanFeedback = await this.hasHumanFeedback();
      if (!hasHumanFeedback) {
        const currentStatus = await this.readQASignoff();
        if (currentStatus?.status === 'approved') {
          this.emitTyped('log', 'Build already approved by QA');
          return this.outcome(true, 0, Date.now() - startTime);
        }
      }

      // Process human feedback first if present
      if (hasHumanFeedback) {
        const feedbackResult = await this.processHumanFeedback();
        if (!feedbackResult.ok) {
          return this.outcome(
            false,
            0,
            Date.now() - startTime,
            feedbackResult.reason,
            feedbackResult.message,
          );
        }
      }

      // Main QA loop
      let consecutiveErrors = 0;
      let lastErrorContext: QAErrorContext | undefined;

      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (this.aborted) {
          return this.outcome(false, iteration - 1, Date.now() - startTime, 'cancelled');
        }

        const iterationStart = Date.now();
        this.emitTyped('qa-iteration-start', iteration, maxIterations);

        // Run QA reviewer
        this.sessionNumber++;
        const reviewPrompt = await this.config.generatePrompt('qa_reviewer', {
          iteration,
          maxIterations,
          previousError: lastErrorContext,
        });

        const reviewResult = await this.config.runSession({
          agentType: 'qa_reviewer',
          phase: 'qa',
          systemPrompt: reviewPrompt,
          specDir: this.config.specDir,
          projectDir: this.config.projectDir,
          sessionNumber: this.sessionNumber,
          abortSignal: this.config.abortSignal,
          cliModel: this.config.cliModel,
          cliThinking: this.config.cliThinking,
        });

        if (reviewResult.outcome === 'cancelled') {
          return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
        }

        // Read QA signoff from implementation_plan.json. Some reviewers write
        // qa_report.md correctly but forget the JSON marker; recover that file
        // verdict before treating the iteration as an agent error.
        const signoff = await this.readQASignoff()
          ?? await this.recoverQASignoffFromReport(iteration);
        const status = this.resolveQAStatus(signoff);
        const issues = signoff?.issues_found ?? [];
        const iterationDuration = Date.now() - iterationStart;

        this.emitTyped('qa-review-complete', iteration, status, issues);

        if (status === 'approved') {
          await this.recordIteration(iteration, 'approved', [], iterationDuration);
          await this.writeReports('approved');
          await this.clearHumanFeedback();
          await this.clearHumanFeedbackState();
          return this.outcome(true, iteration, Date.now() - startTime);
        }

        if (status === 'rejected') {
          consecutiveErrors = 0;
          lastErrorContext = undefined;
          await this.recordIteration(iteration, 'rejected', issues, iterationDuration);

          // Check for recurring issues
          if (this.hasRecurringIssues(issues)) {
            this.emitTyped('log', 'Recurring issues detected — escalating to human review');
            const recurringIssues = this.getRecurringIssues(issues);
            try {
              const escalationReport = generateEscalationReport(this.iterationHistory, recurringIssues);
              await writeFile(join(this.config.specDir, 'QA_ESCALATION.md'), escalationReport, 'utf-8');
            } catch {
              // Non-fatal
            }
            await this.writeReports('escalated');
            return this.outcome(false, iteration, Date.now() - startTime, 'recurring_issues');
          }

          if (iteration >= maxIterations) {
            break; // Max iterations reached
          }

          // Run QA fixer
          this.emitTyped('qa-fix-start', iteration);
          this.sessionNumber++;

          const humanFeedback = await this.readHumanFeedback();
          const fixPrompt = await this.config.generatePrompt('qa_fixer', {
            iteration,
            maxIterations,
            isHumanFeedback: Boolean(humanFeedback),
            humanFeedback: humanFeedback ?? undefined,
          });

          const fixResult = await this.config.runSession({
            agentType: 'qa_fixer',
            phase: 'qa',
            systemPrompt: fixPrompt,
            specDir: this.config.specDir,
            projectDir: this.config.projectDir,
            sessionNumber: this.sessionNumber,
            abortSignal: this.config.abortSignal,
            cliModel: this.config.cliModel,
            cliThinking: this.config.cliThinking,
          });

          if (fixResult.outcome === 'cancelled') {
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'cancelled');
          }

          if (fixResult.outcome === 'error' || fixResult.outcome === 'auth_failure') {
            this.emitTyped('log', `Fixer error: ${fixResult.error?.message ?? 'unknown'}`);
            await this.writeReports('max_iterations');
            return this.outcome(false, iteration, Date.now() - startTime, 'error', fixResult.error?.message);
          }

          this.emitTyped('qa-fix-complete', iteration);
          this.emitTyped('log', 'Fixes applied, re-running QA validation...');
          continue;
        }

        // status === 'unknown' — QA agent didn't update implementation_plan.json
        consecutiveErrors++;
        const errorMsg = 'QA agent did not update implementation_plan.json with qa_signoff';
        await this.recordIteration(iteration, 'error', [{ title: 'QA error', description: errorMsg }], iterationDuration);

        lastErrorContext = {
          errorType: 'missing_implementation_plan_update',
          errorMessage: errorMsg,
          consecutiveErrors,
          expectedAction: 'You MUST update implementation_plan.json with a qa_signoff object containing status: approved or status: rejected',
        };

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.emitTyped('log', `${MAX_CONSECUTIVE_ERRORS} consecutive errors — escalating to human`);
          await this.writeReports('max_iterations');
          return this.outcome(false, iteration, Date.now() - startTime, 'consecutive_errors');
        }

        this.emitTyped('log', `QA error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}), retrying with error feedback...`);
      }

      // Max iterations reached
      await this.writeReports('max_iterations');
      return this.outcome(false, maxIterations, Date.now() - startTime, 'max_iterations');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.outcome(false, 0, Date.now() - startTime, 'error', message);
    }
  }

  // ===========================================================================
  // Status Reading
  // ===========================================================================

  /**
   * Read QA signoff from implementation_plan.json.
   */
  private async readQASignoff(): Promise<QASignoff | null> {
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{ qa_signoff?: unknown }>(raw);
      if (!plan) return null;
      const qa_signoff = plan.qa_signoff;
      if (!qa_signoff) return null;
      const result = validateStructuredOutput(qa_signoff, QASignoffSchema);
      return result.valid && result.data ? (result.data as QASignoff) : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve QA status from signoff data.
   */
  private resolveQAStatus(signoff: QASignoff | null): QAStatus {
    if (!signoff) return 'unknown';
    const status = signoff.status?.toLowerCase();
    if (status === 'approved' || status === 'passed') return 'approved';
    if (status === 'rejected' || status === 'failed' || status === 'issues') return 'rejected';
    if (status === 'fixes_applied') return 'fixes_applied';
    return 'unknown';
  }

  private async recoverQASignoffFromReport(iteration: number): Promise<QASignoff | null> {
    const reportPath = join(this.config.specDir, 'qa_report.md');
    let report = '';
    try {
      report = await readFile(reportPath, 'utf-8');
    } catch {
      return null;
    }

    const match = report.match(/(?:^|\n)\s*(?:\*\*)?\s*Status\s*:\s*(PASSED|PASS|APPROVED|FAILED|FAIL|REJECTED|ISSUES)\s*(?:\*\*)?/i);
    if (!match) return null;

    const rawStatus = match[1].toLowerCase();
    const approved = rawStatus === 'passed' || rawStatus === 'pass' || rawStatus === 'approved';
    const signoff: QASignoff = {
      status: approved ? 'approved' : 'rejected',
      qa_session: iteration,
      issues_found: approved
        ? []
        : [{
          title: 'qa_report.md reported failure',
          description: report.slice(0, 2000),
        }],
    };

    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, unknown>>(raw);
      if (plan) {
        plan.qa_signoff = signoff;
        plan.updated_at = new Date().toISOString();
        await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
      }
    } catch {
      // Returning the recovered signoff still lets this QA iteration proceed.
    }

    this.emitTyped('log', `Recovered QA signoff from qa_report.md (${signoff.status})`);
    return signoff;
  }

  /**
   * Check if all subtasks in the build are completed.
   */
  private async isBuildComplete(): Promise<boolean> {
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{ phases?: Array<{ subtasks: Array<{ status: string }> }> }>(raw);

      if (!plan || !plan.phases) return false;

      for (const phase of plan.phases) {
        for (const subtask of phase.subtasks) {
          if (subtask.status !== 'completed') return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Human Feedback
  // ===========================================================================

  /**
   * Check if human feedback file exists.
   */
  private async hasHumanFeedback(): Promise<boolean> {
    for (const specDir of this.getSpecDirs()) {
      try {
        await readFile(join(specDir, 'QA_FIX_REQUEST.md'), 'utf-8');
        return true;
      } catch {
        // Keep looking in the paired main/worktree spec dir.
      }
    }
    return false;
  }

  private async readHumanFeedback(): Promise<string | null> {
    for (const specDir of this.getSpecDirs()) {
      try {
        const content = await readFile(join(specDir, 'QA_FIX_REQUEST.md'), 'utf-8');
        const trimmed = normalizeQaFailureEvidenceContent(content);
        if (trimmed) return trimmed;
      } catch {
        // Keep looking in the paired main/worktree spec dir.
      }
    }
    return null;
  }

  private async clearHumanFeedback(): Promise<void> {
    for (const specDir of this.getSpecDirs()) {
      try {
        await unlink(join(specDir, 'QA_FIX_REQUEST.md'));
      } catch {
        // No feedback to clear or removal failed; non-fatal after approval.
      }
    }
  }

  private async clearHumanFeedbackState(): Promise<void> {
    for (const specDir of this.getSpecDirs()) {
      try {
        const planPath = join(specDir, 'implementation_plan.json');
        const raw = await readFile(planPath, 'utf-8');
        const plan = safeParseJson<Record<string, unknown>>(raw);
        if (!plan || plan.human_feedback_pending === undefined) continue;
        delete plan.human_feedback_pending;
        plan.updated_at = new Date().toISOString();
        await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
      } catch {
        // Non-fatal after approval.
      }
    }
  }

  private async resetQASignoffForHumanFeedback(humanFeedback: string | null): Promise<void> {
    for (const specDir of this.getSpecDirs()) {
      try {
        const planPath = join(specDir, 'implementation_plan.json');
        const raw = await readFile(planPath, 'utf-8');
        const plan = safeParseJson<Record<string, unknown>>(raw);
        if (!plan) continue;

        delete plan.qa_signoff;
        delete plan.final_acceptance;
        plan.status = 'ai_review';
        plan.planStatus = 'review';
        plan.xstateState = 'qa_fixing';
        plan.executionPhase = 'qa_fixing';
        plan.human_feedback_pending = {
          requested_at: new Date().toISOString(),
          preview: humanFeedback?.slice(0, 500) ?? null,
        };
        plan.updated_at = new Date().toISOString();

        await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
      } catch {
        // Non-fatal: the reviewer still must write a fresh signoff before approval.
      }
    }
  }

  private getSpecDirs(): string[] {
    const dirs = [this.config.specDir];
    if (this.config.sourceSpecDir && this.config.sourceSpecDir !== this.config.specDir) {
      dirs.push(this.config.sourceSpecDir);
    }
    return dirs;
  }

  /**
   * Process human feedback by running the fixer agent first.
   */
  private async processHumanFeedback(): Promise<HumanFeedbackProcessResult> {
    this.emitTyped('log', 'Human feedback detected — running QA Fixer first');
    this.emitTyped('qa-fix-start', 0);
    this.sessionNumber++;

    const humanFeedback = await this.readHumanFeedback();
    await this.resetQASignoffForHumanFeedback(humanFeedback);
    const fixPrompt = await this.config.generatePrompt('qa_fixer', {
      iteration: 0,
      maxIterations: this.config.maxIterations ?? MAX_QA_ITERATIONS,
      isHumanFeedback: true,
      humanFeedback: humanFeedback ?? undefined,
    });

    const result = await this.config.runSession({
      agentType: 'qa_fixer',
      phase: 'qa',
      systemPrompt: fixPrompt,
      specDir: this.config.specDir,
      projectDir: this.config.projectDir,
      sessionNumber: this.sessionNumber,
      abortSignal: this.config.abortSignal,
      cliModel: this.config.cliModel,
      cliThinking: this.config.cliThinking,
    });

    this.emitTyped('qa-fix-complete', 0);
    if (result.outcome === 'cancelled') {
      return { ok: false, reason: 'cancelled' };
    }
    if (result.outcome !== 'completed') {
      return {
        ok: false,
        reason: 'error',
        message: result.error?.message ?? `Human feedback fixer ended with outcome "${result.outcome}"`,
      };
    }
    return { ok: true };
  }

  // ===========================================================================
  // Recurring Issue Detection
  // ===========================================================================

  /**
   * Check if current issues are recurring (appeared RECURRING_ISSUE_THRESHOLD+ times).
   */
  private hasRecurringIssues(currentIssues: QAIssue[]): boolean {
    if (currentIssues.length === 0) return false;

    // Count occurrences of each issue title across history
    const titleCounts = new Map<string, number>();
    for (const record of this.iterationHistory) {
      for (const issue of record.issues) {
        const title = issue.title.toLowerCase().trim();
        titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      }
    }

    // Check if any current issue exceeds threshold
    for (const issue of currentIssues) {
      const title = issue.title.toLowerCase().trim();
      const count = (titleCounts.get(title) ?? 0) + 1; // +1 for current occurrence
      if (count >= RECURRING_ISSUE_THRESHOLD) {
        return true;
      }
    }

    return false;
  }

  /**
   * Record an iteration in the history and persist it to implementation_plan.json.
   */
  private async recordIteration(
    iteration: number,
    status: 'approved' | 'rejected' | 'error',
    issues: QAIssue[],
    durationMs: number,
  ): Promise<void> {
    const record: QAIterationRecord = {
      iteration,
      status,
      issues,
      durationMs,
      timestamp: new Date().toISOString(),
    };

    this.iterationHistory.push(record);

    // Persist to implementation_plan.json
    try {
      const planPath = join(this.config.specDir, 'implementation_plan.json');
      const raw = await readFile(planPath, 'utf-8');
      const plan = safeParseJson<{
        qa_iteration_history?: QAIterationRecord[];
        qa_stats?: Record<string, unknown>;
      }>(raw);

      if (!plan) return;

      if (!plan.qa_iteration_history) {
        plan.qa_iteration_history = [];
      }
      plan.qa_iteration_history.push(record);

      // Update summary stats
      plan.qa_stats = {
        total_iterations: plan.qa_iteration_history.length,
        last_iteration: iteration,
        last_status: status,
      };

      await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    } catch {
      // Non-fatal — iteration is still tracked in memory
    }
  }

  /**
   * Collect issues that are considered "recurring" from history.
   */
  private getRecurringIssues(currentIssues: QAIssue[]): QAIssue[] {
    const recurring: QAIssue[] = [];
    const titleCounts = new Map<string, number>();

    for (const record of this.iterationHistory) {
      for (const issue of record.issues) {
        const key = issue.title.toLowerCase().trim();
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
      }
    }

    for (const issue of currentIssues) {
      const key = issue.title.toLowerCase().trim();
      const count = (titleCounts.get(key) ?? 0) + 1;
      if (count >= RECURRING_ISSUE_THRESHOLD) {
        recurring.push(issue);
      }
    }

    return recurring;
  }

  /**
   * Write all QA reports to disk at the end of the loop.
   */
  private async writeReports(finalStatus: 'approved' | 'escalated' | 'max_iterations'): Promise<void> {
    const specDir = this.config.specDir;
    const projectDir = this.config.projectDir;

    try {
      const qaReport = generateQAReport(this.iterationHistory, finalStatus);
      await writeFile(join(specDir, 'qa_report.md'), qaReport, 'utf-8');
    } catch {
      // Non-fatal
    }

    try {
      const manualTestPlan = await generateManualTestPlan(specDir, projectDir);
      await writeFile(join(specDir, 'MANUAL_TEST_PLAN.md'), manualTestPlan, 'utf-8');
    } catch {
      // Non-fatal
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private outcome(
    approved: boolean,
    totalIterations: number,
    durationMs: number,
    reason?: QAOutcome['reason'],
    error?: string,
  ): QAOutcome {
    const outcome: QAOutcome = {
      approved,
      totalIterations,
      durationMs,
      reason: approved ? undefined : reason,
      error,
    };

    this.emitTyped('qa-complete', outcome);
    return outcome;
  }

  /**
   * Typed event emitter helper.
   */
  private emitTyped<K extends keyof QALoopEvents>(
    event: K,
    ...args: Parameters<QALoopEvents[K]>
  ): void {
    this.emit(event, ...args);
  }
}
