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

    const orchestrator = new BuildOrchestrator({
      specDir: tmpDir,
      projectDir: tmpDir,
      generatePrompt: vi.fn().mockResolvedValue('prompt'),
      runSession: vi.fn(async (config) => {
        callCount++;
        if (config.subtaskId === '1.1') {
          await writeFile(planPath, JSON.stringify(plan(['completed', 'pending']), null, 2));
        }
        return sessionResult('completed');
      }),
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
    expect(written.phases[0].subtasks).toEqual([
      expect.objectContaining({ id: '1.1', status: 'completed' }),
      expect.objectContaining({ id: '1.2', status: 'pending' }),
    ]);
  }, 20_000);
});
