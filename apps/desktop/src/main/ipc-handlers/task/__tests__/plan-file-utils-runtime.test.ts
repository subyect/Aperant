import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tempDirFallback()),
    getVersion: vi.fn(() => 'test'),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../../../cli-tool-manager', () => ({
  getToolPath: vi.fn(() => '/usr/bin/git'),
}));

function tempDirFallback() {
  return tmpdir();
}

function planWithSubtasks() {
  return {
    status: 'in_progress',
    planStatus: 'in_progress',
    xstateState: 'coding',
    executionPhase: 'coding',
    phases: [
      {
        name: 'Phase 1',
        subtasks: [
          { id: '1.1', status: 'completed' },
          { id: '1.2', status: 'pending' },
        ],
      },
    ],
  };
}

describe('plan-file runtime guards', () => {
  let tempDir: string;
  let planPath: string;
  let persistPlanPhaseSync: typeof import('../plan-file-utils').persistPlanPhaseSync;
  let persistPlanStatusAndReasonSync: typeof import('../plan-file-utils').persistPlanStatusAndReasonSync;
  let syncPlanPhasesToMainSync: typeof import('../plan-file-utils').syncPlanPhasesToMainSync;
  let readQaReportVerdictSync: typeof import('../plan-file-utils').readQaReportVerdictSync;
  let readFailedQaEvidenceSync: typeof import('../plan-file-utils').readFailedQaEvidenceSync;
  let readApprovedQASignoffFromReportSync: typeof import('../plan-file-utils').readApprovedQASignoffFromReportSync;
  let recoverApprovedQASignoffForSpec: typeof import('../plan-file-utils').recoverApprovedQASignoffForSpec;
  let ensureHumanFeedbackReworkSubtask: typeof import('../plan-file-utils').ensureHumanFeedbackReworkSubtask;
  let updatePlanAfterAppMerge: typeof import('../plan-file-utils').updatePlanAfterAppMerge;
  let repairFalseCompletedSubtasks: typeof import('../plan-file-utils').repairFalseCompletedSubtasks;

  beforeEach(async () => {
    vi.resetModules();
    ({ persistPlanPhaseSync, persistPlanStatusAndReasonSync, syncPlanPhasesToMainSync, readQaReportVerdictSync, readFailedQaEvidenceSync, readApprovedQASignoffFromReportSync, recoverApprovedQASignoffForSpec, ensureHumanFeedbackReworkSubtask, updatePlanAfterAppMerge, repairFalseCompletedSubtasks } = await import('../plan-file-utils'));
    tempDir = mkdtempSync(path.join(tmpdir(), 'aperant-plan-'));
    planPath = path.join(tempDir, 'implementation_plan.json');
    writeFileSync(planPath, JSON.stringify(planWithSubtasks(), null, 2));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('coerces stopped human review with pending subtasks back to coding runtime state', () => {
    expect(persistPlanStatusAndReasonSync(
      planPath,
      'human_review',
      'stopped',
      'project-1',
      'human_review',
      'complete',
    )).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('in_progress');
    expect(plan.planStatus).toBe('in_progress');
    expect(plan.reviewReason).toBeUndefined();
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.recoveryNote).toBe('Blocked terminal status human_review: 1/2 subtasks complete.');
  });

  it('does not overwrite recovery context during normal in-progress persistence', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'QA report failed; continuing coding with QA findings as mandatory recovery work.',
      phases: [
        {
          name: 'Recovery',
          subtasks: [{ id: 'aperant-qa-report-failure', status: 'pending' }],
        },
      ],
    }, null, 2));

    expect(persistPlanStatusAndReasonSync(
      planPath,
      'in_progress',
      undefined,
      'project-1',
      'coding',
      'coding',
    )).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.recoveryNote).toBe('QA report failed; continuing coding with QA findings as mandatory recovery work.');
  });

  it('removes stale zero-subtask in-progress recovery notes', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'Blocked terminal status in_progress: 0/0 subtasks complete.',
      phases: [
        {
          name: 'Recovery',
          subtasks: [{ id: 'aperant-qa-report-failure', status: 'pending' }],
        },
      ],
    }, null, 2));

    expect(persistPlanStatusAndReasonSync(
      planPath,
      'in_progress',
      undefined,
      'project-1',
      'coding',
      'coding',
    )).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.recoveryNote).toBeUndefined();
  });

  it('synthesizes QA approval when XState persists completed human review after QA_PASSED', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'ai_review',
      planStatus: 'review',
      xstateState: 'qa_review',
      executionPhase: 'qa_review',
      recoveryNote: 'Blocked terminal event QA_PASSED: 2/2 subtasks complete.',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            { id: '1.1', status: 'completed' },
            { id: '1.2', status: 'completed' },
          ],
        },
      ],
    }, null, 2));

    expect(persistPlanStatusAndReasonSync(
      planPath,
      'human_review',
      'completed',
      'project-1',
      'human_review',
      'complete',
    )).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('human_review');
    expect(plan.reviewReason).toBe('completed');
    expect(plan.xstateState).toBe('human_review');
    expect(plan.executionPhase).toBe('complete');
    expect(plan.qa_signoff).toEqual(expect.objectContaining({
      status: 'approved',
      source: 'status-completed-review',
    }));
    expect(plan.recoveryNote).toBeUndefined();
  });

  it('coerces complete phase updates with pending subtasks back to coding runtime state', () => {
    expect(persistPlanPhaseSync(planPath, 'complete', 'project-1')).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('in_progress');
    expect(plan.planStatus).toBe('in_progress');
    expect(plan.reviewReason).toBeUndefined();
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.recoveryNote).toBe('Blocked terminal phase complete: 1/2 subtasks complete.');
  });

  it('keeps qa_fixing phase updates in coding when recovery work remains pending', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            { id: '1.1', status: 'completed' },
            { id: 'aperant-qa-report-failure', status: 'pending' },
          ],
        },
      ],
      qa_signoff: { status: 'approved', issues_found: [] },
    }, null, 2));

    expect(persistPlanPhaseSync(planPath, 'qa_fixing', 'project-1')).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.qa_signoff).toBeUndefined();
  });

  it('reopens auto-completed subtasks backed only by inspection commands', async () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: 'P1-S1',
              status: 'completed',
              completed_at: '2026-05-26T10:00:00.000Z',
              completion_note: [
                'Auto-completed subtask after the agent reported completion and the latest verifier passed.',
                'Command: pwd && cat ./.auto-claude/specs/example/build-progress.txt',
                'Result: build-progress content',
              ].join('\n'),
            },
            {
              id: 'P1-S2',
              status: 'completed',
              completed_at: '2026-05-26T10:00:00.000Z',
              completion_note: [
                'Auto-completed subtask after the agent reported completion and the latest verifier passed.',
                'Command: pwd && pnpm --filter @yect/layer1-db typecheck',
                'Result: tsc --noEmit',
              ].join('\n'),
            },
          ],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const [invalid, valid] = plan.phases[0].subtasks;

    expect(result).toEqual({ success: true, resetCount: 1 });
    expect(invalid.status).toBe('pending');
    expect(invalid.completion_note).toBeUndefined();
    expect(invalid.last_attempt_outcome).toBe('invalid_auto_completion');
    expect(valid.status).toBe('completed');
    expect(plan.recoveryNote).toMatch(/Reset 1 invalid auto-completed subtask/);
  });

  it('does not reopen subtasks when a reachable auto-merge commit already exists', async () => {
    execFileSync('/usr/bin/git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    execFileSync('/usr/bin/git', ['config', 'user.name', 'Aperant Test'], { cwd: tempDir });
    writeFileSync(path.join(tempDir, 'README.md'), 'base\n');
    execFileSync('/usr/bin/git', ['add', 'README.md'], { cwd: tempDir });
    execFileSync('/usr/bin/git', ['commit', '-m', 'Initial commit'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(path.join(tempDir, 'merged.ts'), 'export const merged = true;\n');
    execFileSync('/usr/bin/git', ['add', 'merged.ts'], { cwd: tempDir });
    execFileSync('/usr/bin/git', ['commit', '-m', 'Auto-merge example: Example task'], { cwd: tempDir, stdio: 'ignore' });
    const mergeCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: tempDir, encoding: 'utf-8' }).trim();

    writeFileSync(planPath, JSON.stringify({
      status: 'queue',
      planStatus: 'queued',
      xstateState: 'queue',
      executionPhase: 'idle',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: 'P1-S1',
              status: 'completed',
              completed_at: '2026-05-26T10:00:00.000Z',
              completion_note: [
                'Auto-completed subtask after the agent reported completion and the latest verifier passed.',
                'Command: pwd && cat ./.auto-claude/specs/example/build-progress.txt',
                'Result: build-progress content',
              ].join('\n'),
            },
            {
              id: 'P1-S2',
              status: 'pending',
              last_error: 'Recovered: prior completion had no non-.auto-claude repository changes.',
              last_attempt_outcome: 'false_completion_no_repo_evidence',
            },
          ],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(plan.status).toBe('done');
    expect(plan.planStatus).toBe('completed');
    expect(plan.xstateState).toBe('done');
    expect(plan.executionPhase).toBe('complete');
    expect(plan.mergeCommit).toBe(mergeCommit);
    expect(plan.qa_signoff.status).toBe('approved');
    expect(plan.lastEvent.type).toBe('QA_PASSED');
    expect(plan.phases[0].status).toBe('completed');
    expect(plan.phases[0].subtasks.map((subtask: { status: string }) => subtask.status)).toEqual(['completed', 'completed']);
    expect(plan.phases[0].subtasks[1].last_error).toBeUndefined();
    expect(plan.recoveryNote).toContain('reachable merge commit');
  });

  it('reopens completed human feedback when only part of the required verifier ran', async () => {
    const requiredVerifier = 'pnpm --filter @yect/obyect typecheck && pnpm --filter @yect/obyect test -- src/lib/library/__tests__/useLibraryFeed.tag-filtering.test.ts';
    const partialVerifier = 'pwd && pnpm --filter @yect/obyect test -- src/lib/library/__tests__/useLibraryFeed.tag-filtering.test.ts';

    writeFileSync(planPath, JSON.stringify({
      status: 'done',
      planStatus: 'completed',
      xstateState: 'done',
      executionPhase: 'complete',
      qa_signoff: { status: 'approved', issues_found: [] },
      final_acceptance: { status: 'accepted' },
      mergeCommit: 'abc123',
      mergedAt: '2026-05-26T10:30:00.000Z',
      lastEvent: { type: 'QA_PASSED', timestamp: '2026-05-26T10:29:00.000Z' },
      phases: [
        {
          name: 'Implementation',
          status: 'completed',
          subtasks: [
            { id: 'P1-S1', status: 'completed' },
          ],
        },
        {
          id: 'aperant-human-feedback-rework',
          name: 'Human review feedback',
          type: 'human_feedback_rework',
          status: 'completed',
          subtasks: [
            {
              id: 'aperant-human-feedback-rework',
              title: 'Address human review feedback',
              description: [
                'Address the latest human review feedback recorded in QA_FIX_REQUEST.md.',
                '',
                'Command run from Yect main:',
                requiredVerifier,
              ].join('\n'),
              status: 'completed',
              verification: {
                type: 'manual',
                instructions: 'Verify the feedback is addressed, then rerun QA.',
              },
              completed_at: '2026-05-26T10:00:00.000Z',
              completion_note: [
                'Auto-completed subtask after the agent reported completion and the latest verifier passed.',
                `Command: ${partialVerifier}`,
                'Result: Test Files 1 passed (1)',
              ].join('\n'),
            },
          ],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const reworkSubtask = plan.phases[1].subtasks[0];

    expect(result).toEqual({ success: true, resetCount: 1 });
    expect(plan.status).toBe('in_progress');
    expect(plan.executionPhase).toBe('coding');
    expect(plan.qa_signoff).toBeUndefined();
    expect(plan.final_acceptance).toBeUndefined();
    expect(plan.mergeCommit).toBeUndefined();
    expect(plan.mergedAt).toBeUndefined();
    expect(plan.lastEvent).toBeUndefined();
    expect(reworkSubtask.status).toBe('pending');
    expect(reworkSubtask.verification).toEqual({
      type: 'command',
      run: requiredVerifier,
    });
    expect(reworkSubtask.last_error).toContain('required verifier');
  });

  it('clears stale QA recovery artifacts when false completion reset reopens normal subtasks', async () => {
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), '# stale QA');
    writeFileSync(path.join(tempDir, 'qa_report.md'), '# stale report');
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'QA report failed; continuing coding with QA findings as mandatory recovery work.',
      lastEvent: { type: 'QA_REJECTED', timestamp: '2026-05-26T10:00:00.000Z' },
      qa_signoff: { status: 'rejected' },
      final_acceptance: { status: 'accepted' },
      mergeCommit: 'abc123',
      mergedAt: '2026-05-26T10:30:00.000Z',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: 'P1-S1',
              status: 'completed',
              completed_at: '2026-05-26T10:00:00.000Z',
              completion_note: 'Unproven completion',
            },
          ],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const [subtask] = plan.phases[0].subtasks;

    expect(result).toEqual({ success: true, resetCount: 1 });
    expect(subtask.status).toBe('pending');
    expect(subtask.completion_note).toBeUndefined();
    expect(subtask.last_attempt_outcome).toBe('false_completion_no_repo_evidence');
    expect(existsSync(path.join(tempDir, 'QA_FIX_REQUEST.md'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'qa_report.md'))).toBe(false);
    expect(plan.qa_signoff).toBeUndefined();
    expect(plan.reviewReason).toBeUndefined();
    expect(plan.final_acceptance).toBeUndefined();
    expect(plan.mergeCommit).toBeUndefined();
    expect(plan.mergedAt).toBeUndefined();
    expect(plan.lastEvent).toBeUndefined();
    expect(plan.recoveryNote).toMatch(/Reset 1 false-completed subtask/);
  });

  it('clears stale terminal metadata from already reopened queued plans without changing queue status', async () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'queue',
      planStatus: 'queued',
      xstateState: 'queue',
      executionPhase: 'idle',
      lastEvent: { type: 'ALL_SUBTASKS_DONE', timestamp: '2026-05-26T10:00:00.000Z' },
      qa_signoff: { status: 'approved' },
      final_acceptance: { status: 'accepted' },
      mergeCommit: 'abc123',
      mergedAt: '2026-05-26T10:30:00.000Z',
      phases: [
        {
          name: 'Implementation',
          subtasks: [{ id: 'P1-S1', status: 'pending' }],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(plan.status).toBe('queue');
    expect(plan.planStatus).toBe('queued');
    expect(plan.executionPhase).toBe('idle');
    expect(plan.qa_signoff).toBeUndefined();
    expect(plan.final_acceptance).toBeUndefined();
    expect(plan.mergeCommit).toBeUndefined();
    expect(plan.mergedAt).toBeUndefined();
    expect(plan.lastEvent).toBeUndefined();
  });

  it('persists stale terminal metadata cleanup for partially completed queued plans with repo changes', async () => {
    execFileSync('/usr/bin/git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(path.join(tempDir, 'project-change.ts'), 'export const changed = true;\n');
    writeFileSync(planPath, JSON.stringify({
      status: 'queue',
      planStatus: 'queued',
      xstateState: 'queue',
      executionPhase: 'idle',
      lastEvent: { type: 'ALL_SUBTASKS_DONE', timestamp: '2026-05-26T10:00:00.000Z' },
      qa_signoff: { status: 'approved' },
      final_acceptance: { status: 'accepted' },
      mergeCommit: 'abc123',
      mergedAt: '2026-05-26T10:30:00.000Z',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            { id: 'P1-S1', status: 'completed' },
            { id: 'P1-S2', status: 'pending' },
          ],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(plan.status).toBe('queue');
    expect(plan.planStatus).toBe('queued');
    expect(plan.phases[0].subtasks[0].status).toBe('completed');
    expect(plan.phases[0].subtasks[1].status).toBe('pending');
    expect(plan.qa_signoff).toBeUndefined();
    expect(plan.final_acceptance).toBeUndefined();
    expect(plan.mergeCommit).toBeUndefined();
    expect(plan.mergedAt).toBeUndefined();
    expect(plan.lastEvent).toBeUndefined();
  });

  it('clears stale QA recovery artifacts from already reopened pending plans', async () => {
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), '# stale QA');
    writeFileSync(path.join(tempDir, 'qa_report.md'), '# stale report');
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'QA report failed; continuing coding with QA findings as mandatory recovery work.',
      lastEvent: { type: 'QA_MAX_ITERATIONS', timestamp: '2026-05-26T10:00:00.000Z' },
      phases: [
        {
          name: 'Implementation',
          subtasks: [{ id: 'P1-S1', status: 'pending' }],
        },
        {
          id: 'aperant-qa-report-recovery',
          type: 'qa_report_recovery',
          name: 'QA recovery',
          subtasks: [{ id: 'aperant-qa-report-failure', status: 'pending' }],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(existsSync(path.join(tempDir, 'QA_FIX_REQUEST.md'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'qa_report.md'))).toBe(false);
    expect(plan.lastEvent).toBeUndefined();
    expect(plan.recoveryNote).toMatch(/Cleared stale QA recovery artifacts/);
    expect(plan.executionPhase).toBe('coding');
    expect(plan.phases.flatMap((phase: { subtasks?: Array<{ id?: string }> }) => phase.subtasks ?? []).map((subtask: { id?: string }) => subtask.id)).not.toContain('aperant-qa-report-failure');
    expect(plan.phases.map((phase: { id?: string }) => phase.id)).not.toContain('aperant-qa-report-recovery');
  });

  it('clears empty stale QA recovery phases from reopened pending plans', async () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'Cleared stale QA recovery artifacts for reopened pending subtasks at 2026-05-26T14:38:27.568Z',
      lastEvent: { type: 'CODING_FAILED', timestamp: '2026-05-26T14:50:20.174Z' },
      phases: [
        {
          name: 'Implementation',
          subtasks: [{ id: 'P1-S1', status: 'pending' }],
        },
        {
          id: 'aperant-qa-report-recovery',
          type: 'qa_report_recovery',
          name: 'QA recovery',
          subtasks: [],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(plan.executionPhase).toBe('coding');
    expect(plan.lastEvent).toBeUndefined();
    expect(plan.recoveryNote).toMatch(/Cleared empty stale QA recovery phase/);
    expect(plan.phases.map((phase: { id?: string }) => phase.id)).not.toContain('aperant-qa-report-recovery');
  });

  it('keeps active QA recovery when completed implementation subtasks remain', async () => {
    execFileSync('/usr/bin/git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(path.join(tempDir, 'project-change.ts'), 'export const changed = true;\n');
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), '# active QA');
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      recoveryNote: 'QA report failed; continuing coding with QA findings as mandatory recovery work.',
      phases: [
        {
          name: 'Implementation',
          subtasks: [{ id: 'P1-S1', status: 'completed' }],
        },
        {
          id: 'aperant-qa-report-failure',
          name: 'QA recovery',
          subtasks: [{ id: 'aperant-qa-report-failure', status: 'pending' }],
        },
      ],
    }, null, 2));

    const result = await repairFalseCompletedSubtasks(planPath, tempDir, 'example', 'project-1');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(result).toEqual({ success: true, resetCount: 0 });
    expect(existsSync(path.join(tempDir, 'QA_FIX_REQUEST.md'))).toBe(true);
    expect(plan.recoveryNote).toMatch(/^QA report failed/);
    expect(plan.phases.flatMap((phase: { subtasks?: Array<{ id?: string }> }) => phase.subtasks ?? []).map((subtask: { id?: string }) => subtask.id)).toContain('aperant-qa-report-failure');
  });

  it('clears stale blocked terminal notes when app merge records a completed task', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'human_review',
      planStatus: 'review',
      xstateState: 'human_review',
      executionPhase: 'complete',
      recoveryNote: 'Blocked terminal phase complete: 2/2 subtasks complete.',
      base_sync_conflict: {
        files: ['packages/obyect/src/components/__tests__/optional-ui-dynamic-imports.test.ts'],
        updated_at: '2026-05-25T09:58:40.552Z',
      },
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              status: 'completed',
              last_error: 'Agent session ended without marking the subtask completed.',
              last_attempt_outcome: 'completed',
              last_attempt_at: '2026-05-25T10:00:00.000Z',
            },
            { id: '1.2', status: 'completed' },
          ],
        },
      ],
      qa_signoff: { status: 'approved', issues_found: [] },
    }, null, 2));
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), 'Status: REJECTED\n');
    writeFileSync(path.join(tempDir, 'QA_ESCALATION.md'), '# QA Escalation - Human Intervention Required\n');
    writeFileSync(path.join(tempDir, 'BASE_SYNC_CONFLICT.md'), '# Base Branch Sync Conflict\n');

    updatePlanAfterAppMerge(planPath, 'done', 'completed', 'abc123');

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('done');
    expect(plan.planStatus).toBe('completed');
    expect(plan.mergeCommit).toBe('abc123');
    expect(plan.recoveryNote).toBeUndefined();
    expect(plan.base_sync_conflict).toBeUndefined();
    expect(plan.phases[0].subtasks[0].last_error).toBeUndefined();
    expect(plan.phases[0].subtasks[0].last_attempt_outcome).toBeUndefined();
    expect(plan.phases[0].subtasks[0].last_attempt_at).toBeUndefined();
    expect(existsSync(path.join(tempDir, 'QA_FIX_REQUEST.md'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'QA_ESCALATION.md'))).toBe(false);
    expect(existsSync(path.join(tempDir, 'BASE_SYNC_CONFLICT.md'))).toBe(false);
  });

  it('adds a pending human-feedback rework subtask when feedback arrives after QA', () => {
    const plan = {
      status: 'human_review',
      planStatus: 'review',
      phases: [
        {
          name: 'Implementation',
          status: 'completed',
          subtasks: [{ id: '1.1', title: 'Done', status: 'completed' }],
        },
      ],
      qa_signoff: { status: 'approved', issues_found: [] },
    };

    expect(ensureHumanFeedbackReworkSubtask(plan, 'Use the server-side query; current output is wrong.')).toBe(true);

    const reworkPhase = plan.phases.find((phase: any) => phase.id === 'aperant-human-feedback-rework') as any;
    expect(reworkPhase).toBeTruthy();
    expect(reworkPhase.status).toBe('in_progress');
    expect(reworkPhase.subtasks).toHaveLength(1);
    expect(reworkPhase.subtasks[0]).toMatchObject({
      id: 'aperant-human-feedback-rework',
      title: 'Address human review feedback',
      status: 'pending',
    });
    expect(reworkPhase.subtasks[0].description).toContain('Use the server-side query');
  });

  it('stores a verifier command from human feedback on the rework subtask', () => {
    const plan = {
      status: 'human_review',
      planStatus: 'review',
      phases: [
        {
          name: 'Implementation',
          status: 'completed',
          subtasks: [{ id: '1.1', title: 'Done', status: 'completed' }],
        },
      ],
      qa_signoff: { status: 'approved', issues_found: [] },
    };

    const verifier = 'pnpm --filter @yect/obyect typecheck && pnpm --filter @yect/obyect test -- src/lib/library/__tests__/useLibraryFeed.tag-filtering.test.ts';

    expect(ensureHumanFeedbackReworkSubtask(plan, [
      'Please fix the server-side query.',
      '',
      'Run this before marking done:',
      '```bash',
      verifier,
      '```',
    ].join('\n'))).toBe(true);

    const reworkPhase = plan.phases.find((phase: any) => phase.id === 'aperant-human-feedback-rework') as any;
    const subtask = reworkPhase.subtasks[0];

    expect(subtask.description).toContain('Required verifier before completion');
    expect(subtask.description).toContain(verifier);
    expect(subtask.verification).toEqual({
      type: 'command',
      run: verifier,
    });
  });

  it('does not let transient idle progress overwrite an active runtime phase', () => {
    expect(persistPlanPhaseSync(planPath, 'idle', 'project-1')).toBe(false);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
  });

  it('repairs active planning plans whose durable phase was overwritten with idle', () => {
    writeFileSync(planPath, JSON.stringify({
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'planning',
      executionPhase: 'idle',
      phases: [],
    }, null, 2));

    expect(persistPlanPhaseSync(planPath, 'idle', 'project-1')).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('planning');
    expect(plan.executionPhase).toBe('planning');
  });

  it('does not regress coding tasks with subtasks back to planning progress', () => {
    expect(persistPlanPhaseSync(planPath, 'planning', 'project-1')).toBe(true);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(plan.status).toBe('in_progress');
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
  });

  it('does not replace an existing subtask plan with an empty source plan', () => {
    expect(syncPlanPhasesToMainSync(planPath, {
      phases: [],
      status: 'in_progress',
      xstateState: 'planning',
      executionPhase: 'planning',
    }, 'project-1')).toBe(false);

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(plan.phases[0].subtasks).toHaveLength(2);
    expect(plan.xstateState).toBe('coding');
    expect(plan.executionPhase).toBe('coding');
  });

  it('parses failed QA reports so the app can route them back to coding', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), 'Status: FAILED\n\nMissing smoke evidence.');

    const verdict = readQaReportVerdictSync(tempDir);

    expect(verdict?.status).toBe('failed');
    expect(verdict?.content).toContain('Missing smoke evidence');
    expect(readApprovedQASignoffFromReportSync(tempDir)).toBeNull();
  });

  it('parses generated QA reports that use Final Status and Result fields', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), [
      '# QA Report',
      '',
      '**Final Status**: MAX ITERATIONS REACHED',
      '**Result**: FAILED',
      '',
      'QA validation reached the maximum iterations without approval.',
    ].join('\n'));

    const verdict = readQaReportVerdictSync(tempDir);
    const failure = readFailedQaEvidenceSync(tempDir);

    expect(verdict?.status).toBe('failed');
    expect(failure?.reportPath.endsWith('qa_report.md')).toBe(true);
    expect(failure?.content).toContain('MAX ITERATIONS REACHED');
  });

  it('ignores metadata-only QA plan state so startup reruns QA instead of coding', () => {
    const plan = planWithSubtasks();
    plan.phases[0].subtasks[1].status = 'completed';
    Object.assign(plan, {
      status: 'ai_review',
      planStatus: 'review',
      xstateState: 'qa_review',
      executionPhase: 'failed',
      lastEvent: {
        type: 'QA_MAX_ITERATIONS',
        timestamp: '2026-05-26T11:08:29.483Z',
      },
      qa_stats: {
        total_iterations: 203,
        last_iteration: 3,
        last_status: 'error',
      },
      qa_iteration_history: [
        {
          iteration: 3,
          status: 'error',
          issues: [
            {
              title: 'QA error',
              description: 'QA agent did not update implementation_plan.json with qa_signoff',
            },
          ],
        },
      ],
    });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    expect(readFailedQaEvidenceSync(tempDir)).toBeNull();
  });

  it('ignores metadata-only generated failed QA reports so startup reruns QA instead of coding', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), [
      '# QA Report',
      '',
      '**Final Status**: MAX ITERATIONS REACHED',
      '**Result**: FAILED',
      '',
      '## Iteration History',
      '',
      '### Iteration 1 — ERROR',
      '',
      '- **QA error**',
      '  - QA agent did not update implementation_plan.json with qa_signoff',
      '',
      '## Result',
      '',
      'QA validation reached the maximum of 50 iterations without approval. Human review required.',
    ].join('\n'));

    const verdict = readQaReportVerdictSync(tempDir);

    expect(verdict?.status).toBe('failed');
    expect(readFailedQaEvidenceSync(tempDir)).toBeNull();
  });

  it('uses actionable failed QA plan state as recovery evidence when QA artifacts were cleared', () => {
    const plan = planWithSubtasks();
    plan.phases[0].subtasks[1].status = 'completed';
    Object.assign(plan, {
      status: 'ai_review',
      planStatus: 'review',
      xstateState: 'qa_review',
      executionPhase: 'failed',
      lastEvent: {
        type: 'QA_MAX_ITERATIONS',
        timestamp: '2026-05-26T11:08:29.483Z',
      },
      qa_stats: {
        total_iterations: 4,
        last_iteration: 3,
        last_status: 'rejected',
      },
      qa_iteration_history: [
        {
          iteration: 3,
          status: 'rejected',
          issues: [
            {
              title: 'Missing regression test',
              description: 'Add coverage for the shared filter helper.',
            },
          ],
        },
      ],
    });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    const failure = readFailedQaEvidenceSync(tempDir);
    expect(failure?.reportPath.endsWith('implementation_plan.json#qa-failure-state')).toBe(true);
    expect(failure?.content).toContain('Status: FAILED');
    expect(failure?.content).toContain('QA_MAX_ITERATIONS');
    expect(failure?.content).toContain('Missing regression test');
  });

  it('uses QA escalation reports as fallback failure evidence', () => {
    writeFileSync(path.join(tempDir, 'QA_ESCALATION.md'), [
      '# QA Escalation - Human Intervention Required',
      '',
      'Recurring Issues',
    ].join('\n'));

    const failure = readFailedQaEvidenceSync(tempDir);

    expect(failure?.reportPath.endsWith('QA_ESCALATION.md')).toBe(true);
    expect(failure?.content).toContain('Recurring Issues');
  });

  it('parses generated approved QA reports that use Result fields', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), [
      '# QA Report',
      '',
      '**Final Status**: APPROVED',
      '**Result**: PASSED',
      '',
      'QA validation passed successfully.',
    ].join('\n'));

    const verdict = readQaReportVerdictSync(tempDir);

    expect(verdict?.status).toBe('approved');
    expect(readFailedQaEvidenceSync(tempDir)).toBeNull();
  });

  it('treats approved QA reports with unresolved verification failures as failed', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), [
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      'Verification executed:',
      '- Result: test suite has unrelated failures outside this spec.',
    ].join('\n'));

    const verdict = readQaReportVerdictSync(tempDir);
    const failure = readFailedQaEvidenceSync(tempDir);

    expect(verdict?.status).toBe('failed');
    expect(failure?.reportPath.endsWith('qa_report.md')).toBe(true);
    expect(readApprovedQASignoffFromReportSync(tempDir)).toBeNull();
  });

  it('does not treat stale escalation files as failed when the QA report is approved', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), '**Result**: PASSED\n');
    writeFileSync(path.join(tempDir, 'QA_ESCALATION.md'), '# QA Escalation - Human Intervention Required\n');

    expect(readFailedQaEvidenceSync(tempDir)).toBeNull();
  });

  it('keeps failed QA fix requests as durable failure evidence', () => {
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), '# QA Fix Request\n\nStatus: REJECTED\n\nAperant QA failed this task.');

    const failure = readFailedQaEvidenceSync(tempDir);

    expect(failure?.reportPath.endsWith('QA_FIX_REQUEST.md')).toBe(true);
    expect(failure?.content).toContain('Status: REJECTED');
  });

  it('unwraps recursively nested QA fix requests before reusing failure evidence', () => {
    const failedReport = [
      'Status: FAILED',
      '',
      'The route smoke still fails because @yect/layer1-db cannot resolve query-helpers.',
    ].join('\n');
    const nestedRequest = [
      '# QA Fix Request',
      '',
      'Status: REJECTED',
      '',
      '## Feedback',
      '',
      'Aperant QA failed this task.',
      '',
      '## Failed QA Report',
      '',
      '```markdown',
      failedReport,
      '```',
      '',
      'Created at: 2026-05-25T17:00:00.000Z',
      '',
    ].join('\n');
    writeFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), [
      '# QA Fix Request',
      '',
      'Status: REJECTED',
      '',
      '## Feedback',
      '',
      'Aperant QA failed this task.',
      '',
      '## Failed QA Report',
      '',
      '```markdown',
      nestedRequest,
      '```',
      '',
      'Created at: 2026-05-25T17:05:00.000Z',
      '',
    ].join('\n'));

    const failure = readFailedQaEvidenceSync(tempDir);

    expect(failure?.reportPath.endsWith('QA_FIX_REQUEST.md')).toBe(true);
    expect(failure?.content).toBe(failedReport);
    expect(failure?.content).not.toContain('## Failed QA Report');
    expect(failure?.content).not.toContain('# QA Fix Request');

    const normalizedFile = readFileSync(path.join(tempDir, 'QA_FIX_REQUEST.md'), 'utf-8');
    expect(normalizedFile.match(/^# QA Fix Request/gm)).toHaveLength(1);
    expect(normalizedFile).toContain(failedReport);
    expect(normalizedFile).not.toContain(nestedRequest);
  });

  it('still recovers approved QA signoff from passed reports', () => {
    writeFileSync(path.join(tempDir, 'qa_report.md'), '**Status: PASSED**\n');

    const verdict = readQaReportVerdictSync(tempDir);
    const signoff = readApprovedQASignoffFromReportSync(tempDir);

    expect(verdict?.status).toBe('approved');
    expect(signoff?.status).toBe('approved');
  });

  it('promotes completed QA tasks from passed report evidence', () => {
    const projectRoot = path.join(tempDir, 'project');
    const specId = '001-passed-report';
    const specDir = path.join(projectRoot, '.auto-claude', 'specs', specId);
    mkdirSync(specDir, { recursive: true });

    const plan = planWithSubtasks();
    plan.phases[0].subtasks[1].status = 'completed';
    (plan as any).human_feedback_pending = { requested_at: '2026-05-23T19:40:25.571Z' };
    (plan as any).recoveryNote = 'QA report failed; continuing coding with QA findings as mandatory recovery work.';
    writeFileSync(path.join(specDir, 'implementation_plan.json'), JSON.stringify(plan, null, 2));
    writeFileSync(path.join(specDir, 'qa_report.md'), 'Status: PASSED\n');
    writeFileSync(path.join(specDir, 'QA_FIX_REQUEST.md'), 'Status: REJECTED\n');
    writeFileSync(path.join(specDir, 'QA_ESCALATION.md'), '# QA Escalation - Human Intervention Required\n');

    expect(recoverApprovedQASignoffForSpec({
      id: 'project-1',
      name: 'Project',
      path: projectRoot,
      autoBuildPath: '.auto-claude',
      settings: {},
    } as any, specId, 'test-recovery')).toBe(true);

    const recovered = JSON.parse(readFileSync(path.join(specDir, 'implementation_plan.json'), 'utf-8'));
    expect(recovered.status).toBe('human_review');
    expect(recovered.qa_signoff.status).toBe('approved');
    expect(recovered.lastEvent.type).toBe('QA_PASSED');
    expect(recovered.human_feedback_pending).toBeUndefined();
    expect(recovered.recoveryNote).toBeUndefined();
    expect(existsSync(path.join(specDir, 'QA_FIX_REQUEST.md'))).toBe(false);
    expect(existsSync(path.join(specDir, 'QA_ESCALATION.md'))).toBe(false);
  });
});
