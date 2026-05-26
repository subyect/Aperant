import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BuildOrchestrator } from '../build-orchestrator';
import type { SessionResult } from '../../session/types';

function sessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    totalSteps: 1,
    lastMessage: '',
  } as unknown as SessionResult;
}

function plan(statuses: string[]) {
  return {
    feature: 'test',
    workflow_type: 'feature',
    phases: [
      {
        phase: 1,
        name: 'Phase 1',
        subtasks: statuses.map((status, index) => ({
          id: `1.${index + 1}`,
          title: `Task ${index + 1}`,
          description: `Do task ${index + 1}`,
          status,
        })),
      },
    ],
  };
}

describe('BuildOrchestrator coding phase', () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'build-orchestrator-test-'));
    planPath = join(tmpDir, 'implementation_plan.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not complete coding when a subtask is still pending', async () => {
    await writeFile(planPath, JSON.stringify(plan(['pending', 'pending']), null, 2));
    let callCount = 0;
    const generatePrompt = vi.fn().mockResolvedValue('prompt');
    const runSession = vi.fn(async (config) => {
      callCount++;
      if (config.subtaskId === '1.1') {
        await writeFile(planPath, JSON.stringify(plan(['completed', 'pending']), null, 2));
      }
      return sessionResult('completed');
    });

    const orchestrator = new BuildOrchestrator({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxSubtaskRetries: 1,
      autoContinueDelayMs: 0,
      generatePrompt,
      runSession,
    });

    const result = await (orchestrator as unknown as {
      runCodingPhase: () => Promise<{ success: boolean; error?: string }>;
    }).runCodingPhase();

    const written = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ id: string; status: string }> }>;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('Coding incomplete');
    expect(callCount).toBeGreaterThan(1);
    expect(generatePrompt).toHaveBeenCalledWith('coder', 'coding', expect.objectContaining({
      subtask: expect.objectContaining({ id: '1.1', description: 'Do task 1' }),
    }));
    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({
      subtaskId: '1.1',
      subtask: expect.objectContaining({ id: '1.1', description: 'Do task 1' }),
    }));
    expect(written.phases[0].subtasks).toEqual([
      expect.objectContaining({ id: '1.1', status: 'completed' }),
      expect.objectContaining({ id: '1.2', status: 'pending' }),
    ]);
  }, 20_000);

  it('runs QA when all subtasks are complete but no approved QA signoff exists', async () => {
    await writeFile(planPath, JSON.stringify(plan(['completed']), null, 2));
    const generatePrompt = vi.fn().mockResolvedValue('prompt');
    const runSession = vi.fn(async (config) => {
      if (config.agentType === 'qa_reviewer') {
        await writeFile(join(tmpDir, 'qa_report.md'), 'Status: PASSED\n');
      }
      return sessionResult('completed');
    });

    const orchestrator = new BuildOrchestrator({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxSubtaskRetries: 1,
      autoContinueDelayMs: 0,
      generatePrompt,
      runSession,
    });

    const result = await orchestrator.run();

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(runSession).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'qa_reviewer',
    }));
  }, 20_000);
});
