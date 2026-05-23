import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { iterateSubtasks, restampExecutionPhase } from '../subtask-iterator';
import type { SessionResult } from '../../session/types';

function sessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    error: outcome === 'error' ? new Error('session failed') : undefined,
    totalSteps: 1,
    lastMessage: '',
  } as unknown as SessionResult;
}

function planWithStatus(status: string) {
  return {
    feature: 'test',
    phases: [
      {
        name: 'Phase 1',
        subtasks: [
          {
            id: '1.1',
            title: 'Do work',
            description: 'Do the work',
            status,
          },
        ],
      },
    ],
  };
}

// =============================================================================
// restampExecutionPhase
// =============================================================================

describe('restampExecutionPhase', () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'restamp-test-'));
    planPath = join(tmpDir, 'implementation_plan.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('updates a stale executionPhase and writes the file back', async () => {
    const plan = {
      feature: 'test',
      executionPhase: 'planning',
      phases: [],
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2));

    await restampExecutionPhase(tmpDir, 'coding');

    const written = JSON.parse(await readFile(planPath, 'utf-8')) as Record<string, unknown>;
    expect(written.executionPhase).toBe('coding');
  });

  it('does not rewrite the file when executionPhase is already correct', async () => {
    const plan = {
      feature: 'test',
      executionPhase: 'coding',
      phases: [],
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2));

    // Snapshot content before calling the function
    const contentBefore = await readFile(planPath, 'utf-8');

    await restampExecutionPhase(tmpDir, 'coding');

    // Verify file was not modified — content should be byte-identical
    const contentAfter = await readFile(planPath, 'utf-8');
    expect(contentAfter).toBe(contentBefore);

    const written = JSON.parse(contentAfter) as Record<string, unknown>;
    expect(written.executionPhase).toBe('coding');
  });

  it('handles a missing file gracefully without throwing', async () => {
    // planPath does NOT exist — the function should swallow the error
    await expect(restampExecutionPhase(tmpDir, 'coding')).resolves.toBeUndefined();
  });

  it('handles corrupt JSON gracefully without throwing', async () => {
    await writeFile(planPath, '{ this is not valid json }{{{');

    await expect(restampExecutionPhase(tmpDir, 'coding')).resolves.toBeUndefined();
  });
});

describe('iterateSubtasks completion proof', () => {
  let tmpDir: string;
  let planPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'subtask-iterator-test-'));
    planPath = join(tmpDir, 'implementation_plan.json');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not mark a subtask completed only because the session completed', async () => {
    await writeFile(planPath, JSON.stringify(planWithStatus('pending'), null, 2));

    const result = await iterateSubtasks({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => sessionResult('completed'),
    });

    const written = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ status: string; last_error?: string }> }>;
    };
    const subtask = written.phases[0].subtasks[0];

    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['1.1']);
    expect(subtask.status).toBe('pending');
    expect(subtask.last_error).toContain('without marking the subtask completed');
  });

  it('counts a subtask completed when the agent updates the plan', async () => {
    await writeFile(planPath, JSON.stringify(planWithStatus('pending'), null, 2));

    const result = await iterateSubtasks({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => {
        const plan = planWithStatus('completed');
        await writeFile(planPath, JSON.stringify(plan, null, 2));
        return sessionResult('completed');
      },
    });

    const written = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ status: string }> }>;
    };

    expect(result.completedSubtasks).toBe(1);
    expect(result.stuckSubtasks).toEqual([]);
    expect(written.phases[0].subtasks[0].status).toBe('completed');
  });

  it('retries instead of completing when the session hits max steps', async () => {
    await writeFile(planPath, JSON.stringify(planWithStatus('pending'), null, 2));

    const result = await iterateSubtasks({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async () => sessionResult('max_steps'),
    });

    const written = JSON.parse(await readFile(planPath, 'utf-8')) as {
      phases: Array<{ subtasks: Array<{ status: string; last_error?: string }> }>;
    };

    expect(result.completedSubtasks).toBe(0);
    expect(result.stuckSubtasks).toEqual(['1.1']);
    expect(written.phases[0].subtasks[0].status).toBe('pending');
    expect(written.phases[0].subtasks[0].last_error).toContain('max step limit');
  });

  it('passes prior retry context into the next subtask session', async () => {
    const plan = planWithStatus('pending') as ReturnType<typeof planWithStatus> & {
      phases: Array<{
        subtasks: Array<{
          last_error?: string;
          last_attempt_outcome?: string;
          files_to_modify?: string[];
        }>;
      }>;
    };
    plan.phases[0].subtasks[0].last_error = 'Previous run only read files and did not implement changes.';
    plan.phases[0].subtasks[0].last_attempt_outcome = 'completed';
    plan.phases[0].subtasks[0].files_to_modify = ['src/example.ts'];
    await writeFile(planPath, JSON.stringify(plan, null, 2));

    const seen: Array<{
      id: string;
      lastError?: string;
      lastAttemptOutcome?: string;
      filesToModify?: string[];
    }> = [];

    await iterateSubtasks({
      specDir: tmpDir,
      projectDir: tmpDir,
      maxRetries: 1,
      autoContinueDelayMs: 0,
      runSubtaskSession: async (subtask) => {
        seen.push(subtask);
        await writeFile(planPath, JSON.stringify(planWithStatus('completed'), null, 2));
        return sessionResult('completed');
      },
    });

    expect(seen[0]).toEqual(expect.objectContaining({
      id: '1.1',
      lastError: 'Previous run only read files and did not implement changes.',
      lastAttemptOutcome: 'completed',
      filesToModify: ['src/example.ts'],
    }));
  });
});
