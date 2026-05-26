import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const projectStoreMock = vi.hoisted(() => ({
  getProjects: vi.fn(),
  getTasks: vi.fn(),
  invalidateTasksCache: vi.fn(),
}));

const taskStateManagerMock = vi.hoisted(() => ({
  handleUiEvent: vi.fn(),
  prepareForRestart: vi.fn(),
}));

vi.mock('../project-store', () => ({
  projectStore: projectStoreMock,
}));

vi.mock('../task-state-manager', () => ({
  taskStateManager: taskStateManagerMock,
}));

vi.mock('../settings-utils', () => ({
  readSettingsFile: vi.fn(() => ({})),
}));

vi.mock('../cli-tool-manager', () => ({
  getToolPath: vi.fn((tool: string) => tool),
}));

vi.mock('../claude-profile-manager', () => ({
  getClaudeProfileManager: vi.fn(() => null),
  initializeClaudeProfileManager: vi.fn(),
}));

vi.mock('../claude-profile/operation-registry', () => ({
  getOperationRegistry: vi.fn(() => ({
    unregisterOperation: vi.fn(),
  })),
}));

vi.mock('../ai/auth/resolver', () => ({
  resolveAuth: vi.fn(),
  resolveAuthFromQueue: vi.fn(),
}));

vi.mock('../ai/worktree', () => ({
  createOrGetWorktree: vi.fn(),
  syncWorktreeWithBaseBranch: vi.fn(),
}));

vi.mock('../utils/worktree-cleanup', () => ({
  cleanupWorktree: vi.fn(),
}));

vi.mock('../ai/merge/orchestrator', () => ({
  MergeOrchestrator: vi.fn(),
}));

vi.mock('../ai/runners/merge-resolver', () => ({
  createMergeResolverFn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
  },
}));

import { AgentManager } from './agent-manager';

describe('AgentManager workflow recovery', () => {
  let rootDir: string;
  let projectPath: string;
  let planPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    rootDir = mkdtempSync(path.join(tmpdir(), 'aperant-agent-recovery-'));
    projectPath = path.join(rootDir, 'project');
    const specDir = path.join(projectPath, '.auto-claude', 'specs', 'task-001');
    mkdirSync(specDir, { recursive: true });
    writeFileSync(path.join(specDir, 'spec.md'), '# Task\n');
    planPath = path.join(specDir, 'implementation_plan.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reroutes completed in-progress tasks to QA instead of restarting coding', async () => {
    writeFileSync(planPath, JSON.stringify({
      feature: 'Task',
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1', title: 'Done', status: 'completed' },
          ],
        },
      ],
    }, null, 2));

    const project = {
      id: 'project-1',
      path: projectPath,
      autoBuildPath: '.auto-claude',
      settings: { maxParallelTasks: 3, mainBranch: 'main' },
    };
    const task = {
      id: 'task-id-1',
      specId: 'task-001',
      title: 'Task',
      description: 'Task',
      status: 'in_progress',
      updatedAt: new Date('2026-05-26T10:00:00.000Z'),
      metadata: {},
      subtasks: [{ id: '1', title: 'Done', status: 'completed' }],
    };

    projectStoreMock.getProjects.mockReturnValue([project]);
    projectStoreMock.getTasks.mockReturnValue([task]);

    const manager = new AgentManager();
    const startQAProcess = vi
      .spyOn(manager as unknown as { startQAProcess: (...args: unknown[]) => Promise<void> }, 'startQAProcess')
      .mockResolvedValue(undefined);
    const startTaskExecution = vi
      .spyOn(manager as unknown as { startTaskExecution: (...args: unknown[]) => Promise<void> }, 'startTaskExecution')
      .mockResolvedValue(undefined);

    await manager.runWorkflowRecoveryPass('test');

    expect(startQAProcess).toHaveBeenCalledWith('task-id-1', projectPath, 'task-001', 'project-1');
    expect(startTaskExecution).not.toHaveBeenCalled();

    const persisted = JSON.parse(readFileSync(planPath, 'utf-8')) as {
      status?: string;
      planStatus?: string;
      xstateState?: string;
      executionPhase?: string;
    };
    expect(persisted.status).toBe('ai_review');
    expect(persisted.planStatus).toBe('review');
    expect(persisted.xstateState).toBe('qa_review');
    expect(persisted.executionPhase).toBe('qa_review');
  });

  it('clears exited worker handles before enforcing project capacity', async () => {
    writeFileSync(planPath, JSON.stringify({
      feature: 'Task',
      status: 'in_progress',
      planStatus: 'in_progress',
      xstateState: 'coding',
      executionPhase: 'coding',
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1', title: 'Pending', status: 'pending' },
          ],
        },
      ],
    }, null, 2));

    const project = {
      id: 'project-1',
      path: projectPath,
      autoBuildPath: '.auto-claude',
      settings: { maxParallelTasks: 1, mainBranch: 'main' },
    };
    const task = {
      id: 'task-id-1',
      specId: 'task-001',
      title: 'Task',
      description: 'Task',
      status: 'in_progress',
      updatedAt: new Date('2026-05-26T10:00:00.000Z'),
      metadata: {},
      subtasks: [{ id: '1', title: 'Pending', status: 'pending' }],
    };

    projectStoreMock.getProjects.mockReturnValue([project]);
    projectStoreMock.getTasks.mockReturnValue([task]);

    const manager = new AgentManager();
    const killedWorker = {
      exitCode: 0,
      signalCode: null,
      connected: false,
      kill: vi.fn(),
    };
    (manager as unknown as {
      state: {
        addProcess: (taskId: string, process: unknown) => void;
      };
    }).state.addProcess(task.id, {
      taskId: task.id,
      process: null,
      worker: killedWorker,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      spawnId: 1,
      projectId: project.id,
      processType: 'task-execution',
    });

    const startTaskExecution = vi
      .spyOn(manager as unknown as { startTaskExecution: (...args: unknown[]) => Promise<void> }, 'startTaskExecution')
      .mockResolvedValue(undefined);

    await manager.runWorkflowRecoveryPass('test');

    expect(killedWorker.kill).toHaveBeenCalledWith('SIGTERM');
    expect(startTaskExecution).toHaveBeenCalledWith(
      task.id,
      projectPath,
      task.specId,
      expect.objectContaining({ baseBranch: 'main', workers: 1 }),
      project.id,
    );
  });
});
