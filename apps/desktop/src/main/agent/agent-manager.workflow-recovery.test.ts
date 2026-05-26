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

import { AgentManager, getProcessStatCommand, isZombieProcessStat } from './agent-manager';

describe('process liveness helpers', () => {
  it('treats zombie ps stat values as not live', () => {
    expect(isZombieProcessStat('Z')).toBe(true);
    expect(isZombieProcessStat('Z+')).toBe(true);
    expect(isZombieProcessStat('R')).toBe(false);
    expect(isZombieProcessStat('Ss')).toBe(false);
  });

  it('uses an absolute ps path when available for packaged app process checks', () => {
    expect(getProcessStatCommand()).toBe('/bin/ps');
  });
});

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

  it('routes completed in-progress tasks with failed QA reports back to coding', async () => {
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
    writeFileSync(path.join(path.dirname(planPath), 'qa_report.md'), [
      'Status: FAILED',
      '',
      'The task still fails focused verification.',
    ].join('\n'));

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

    expect(startQAProcess).not.toHaveBeenCalled();
    expect(startTaskExecution).toHaveBeenCalledWith(
      task.id,
      projectPath,
      task.specId,
      expect.objectContaining({ baseBranch: 'main', workers: 1 }),
      project.id,
    );

    const persisted = JSON.parse(readFileSync(planPath, 'utf-8')) as {
      status?: string;
      xstateState?: string;
      executionPhase?: string;
      phases?: Array<{ subtasks?: Array<{ id?: string; status?: string; description?: string; verification?: { run?: string } }> }>;
    };
    const recoverySubtask = persisted.phases
      ?.flatMap((phase) => phase.subtasks ?? [])
      .find((subtask) => subtask.id === 'aperant-qa-report-failure');
    expect(persisted.status).toBe('in_progress');
    expect(persisted.xstateState).toBe('coding');
    expect(persisted.executionPhase).toBe('coding');
    expect(recoverySubtask?.status).toBe('pending');
    expect(recoverySubtask?.description).toContain('Active fix request:');
    expect(recoverySubtask?.description).toContain('Read QA_FIX_REQUEST.md first');
    expect(recoverySubtask?.verification?.run).toContain('Read QA_FIX_REQUEST.md first');
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

  it('drops child worker handles whose exit event was missed', async () => {
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

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 999999 && signal === 0) {
        const error = new Error('No such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    try {
      const manager = new AgentManager();
      const missedExitWorker = {
        pid: 999999,
        exitCode: null,
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
        worker: missedExitWorker,
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

      expect(killSpy).toHaveBeenCalledWith(999999, 0);
      expect(missedExitWorker.kill).toHaveBeenCalledWith('SIGTERM');
      expect(startTaskExecution).toHaveBeenCalledWith(
        task.id,
        projectPath,
        task.specId,
        expect.objectContaining({ baseBranch: 'main', workers: 1 }),
        project.id,
      );
      expect(manager.isRunning(task.id)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('moves inactive in-progress recovery candidates back to queue when capacity is full', async () => {
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
    const runningTask = {
      id: 'task-running',
      specId: 'task-running',
      title: 'Running',
      description: 'Running',
      status: 'in_progress',
      updatedAt: new Date('2026-05-26T09:00:00.000Z'),
      metadata: {},
      subtasks: [{ id: '1', title: 'Pending', status: 'pending' }],
    };
    const deferredTask = {
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
    projectStoreMock.getTasks.mockReturnValue([runningTask, deferredTask]);

    const manager = new AgentManager();
    (manager as unknown as {
      state: {
        addProcess: (taskId: string, process: unknown) => void;
      };
    }).state.addProcess(runningTask.id, {
      taskId: runningTask.id,
      process: null,
      worker: { pid: process.pid },
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

    expect(startTaskExecution).not.toHaveBeenCalledWith(
      deferredTask.id,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    const persisted = JSON.parse(readFileSync(planPath, 'utf-8')) as {
      status?: string;
      planStatus?: string;
      xstateState?: string;
      executionPhase?: string;
    };
    expect(persisted.status).toBe('queue');
    expect(persisted.planStatus).toBe('queued');
    expect(persisted.xstateState).toBe('queue');
    expect(persisted.executionPhase).toBe('idle');
  });

  it('clears opaque worker handles that have no live process marker', async () => {
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
    (manager as unknown as {
      state: {
        addProcess: (taskId: string, process: unknown) => void;
      };
    }).state.addProcess(task.id, {
      taskId: task.id,
      process: null,
      worker: {},
      startedAt: new Date(Date.now() - 60_000),
      lastActivityAt: new Date(Date.now() - 60_000),
      spawnId: 1,
      projectId: project.id,
      processType: 'task-execution',
    });

    const startTaskExecution = vi
      .spyOn(manager as unknown as { startTaskExecution: (...args: unknown[]) => Promise<void> }, 'startTaskExecution')
      .mockResolvedValue(undefined);

    await manager.runWorkflowRecoveryPass('test');

    expect(startTaskExecution).toHaveBeenCalledWith(
      task.id,
      projectPath,
      task.specId,
      expect.objectContaining({ baseBranch: 'main', workers: 1 }),
      project.id,
    );
    expect(manager.isRunning(task.id)).toBe(false);
  });

  it('prioritizes queued implementation work over queued planning work with older timestamps', async () => {
    const implementationSpecId = 'task-010';
    const implementationSpecDir = path.join(projectPath, '.auto-claude', 'specs', implementationSpecId);
    const implementationPlanPath = path.join(implementationSpecDir, 'implementation_plan.json');
    mkdirSync(implementationSpecDir, { recursive: true });
    writeFileSync(path.join(implementationSpecDir, 'spec.md'), '# Implementation task\n');
    writeFileSync(implementationPlanPath, JSON.stringify({
      feature: 'Implementation task',
      status: 'queue',
      planStatus: 'queued',
      xstateState: 'queue',
      executionPhase: 'idle',
      phases: [
        {
          id: 'phase-1',
          name: 'Implementation',
          subtasks: [
            { id: '1', title: 'Done', status: 'completed' },
            { id: '2', title: 'Pending', status: 'pending' },
          ],
        },
      ],
    }, null, 2));

    const planningSpecId = 'task-002';
    const planningSpecDir = path.join(projectPath, '.auto-claude', 'specs', planningSpecId);
    mkdirSync(planningSpecDir, { recursive: true });

    const project = {
      id: 'project-1',
      path: projectPath,
      autoBuildPath: '.auto-claude',
      settings: { maxParallelTasks: 1, mainBranch: 'main' },
    };
    const implementationTask = {
      id: 'task-id-implementation',
      specId: implementationSpecId,
      title: 'Implementation task',
      description: 'Implementation task',
      status: 'queue',
      createdAt: new Date('invalid'),
      updatedAt: new Date('2026-05-26T10:00:00.000Z'),
      metadata: {},
      subtasks: [
        { id: '1', title: 'Done', status: 'completed' },
        { id: '2', title: 'Pending', status: 'pending' },
      ],
    };
    const planningTask = {
      id: 'task-id-planning',
      specId: planningSpecId,
      title: 'Planning task',
      description: 'Planning task',
      status: 'queue',
      createdAt: new Date('2026-05-20T10:00:00.000Z'),
      updatedAt: new Date('2026-05-20T10:00:00.000Z'),
      metadata: {},
      subtasks: [],
    };

    projectStoreMock.getProjects.mockReturnValue([project]);
    projectStoreMock.getTasks.mockReturnValue([planningTask, implementationTask]);

    const manager = new AgentManager();
    const startTaskExecution = vi
      .spyOn(manager as unknown as { startTaskExecution: (...args: unknown[]) => Promise<void> }, 'startTaskExecution')
      .mockImplementation(async () => {
        (manager as unknown as {
          state: {
            addProcess: (taskId: string, process: unknown) => void;
          };
        }).state.addProcess(implementationTask.id, {
          taskId: implementationTask.id,
          process: null,
          worker: { pid: process.pid },
          startedAt: new Date(),
          lastActivityAt: new Date(),
          spawnId: 1,
          projectId: project.id,
          processType: 'task-execution',
        });
      });
    const startSpecCreation = vi
      .spyOn(manager as unknown as { startSpecCreation: (...args: unknown[]) => Promise<void> }, 'startSpecCreation')
      .mockResolvedValue(undefined);

    await manager.runWorkflowRecoveryPass('test');

    expect(startTaskExecution).toHaveBeenCalledWith(
      implementationTask.id,
      projectPath,
      implementationSpecId,
      expect.objectContaining({ baseBranch: 'main', workers: 1 }),
      project.id,
    );
    expect(startSpecCreation).not.toHaveBeenCalled();
  });
});
