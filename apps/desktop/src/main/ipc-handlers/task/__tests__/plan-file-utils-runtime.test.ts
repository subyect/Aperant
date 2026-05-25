import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  beforeEach(async () => {
    vi.resetModules();
    ({ persistPlanPhaseSync, persistPlanStatusAndReasonSync, syncPlanPhasesToMainSync, readQaReportVerdictSync, readFailedQaEvidenceSync, readApprovedQASignoffFromReportSync, recoverApprovedQASignoffForSpec, ensureHumanFeedbackReworkSubtask, updatePlanAfterAppMerge } = await import('../plan-file-utils'));
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
