import { describe, expect, it } from 'vitest';

import {
  BASE_SYNC_RECOVERY_NOTE,
  BASE_SYNC_RECOVERY_SUBTASK_ID,
  isBaseSyncConflictRecoveryCurrent,
} from './base-sync-recovery';

const files = ['packages/layer1-console/README.md'];
const reason = 'worktree_has_unmerged_conflicts';
const description = [
  'Resolve the Git conflict markers created while updating this task worktree to the current base branch.',
  '',
  'Conflicted files:',
  ...files.map((file) => `- ${file}`),
  '',
  'Preserve the task implementation and current base-branch behavior. Do not mark this subtask complete until `git diff --name-only --diff-filter=U` returns no files and focused verification for the touched area is recorded.',
].join('\n');

function currentPlan(overrides: Record<string, unknown> = {}) {
  return {
    status: 'in_progress',
    planStatus: 'in_progress',
    xstateState: 'coding',
    executionPhase: 'coding',
    recoveryNote: BASE_SYNC_RECOVERY_NOTE,
    base_sync_conflict: {
      files,
      reason,
      updated_at: '2026-05-25T16:00:00.000Z',
    },
    lastEvent: {
      type: 'BASE_SYNC_CONFLICT',
      timestamp: '2026-05-25T16:00:00.000Z',
    },
    phases: [
      {
        id: 'aperant-base-sync-recovery',
        status: 'in_progress',
        subtasks: [
          {
            id: BASE_SYNC_RECOVERY_SUBTASK_ID,
            title: 'Resolve base branch sync conflicts',
            description,
            status: 'pending',
            verification: {
              type: 'command',
              run: 'git diff --name-only --diff-filter=U && git status --short',
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('isBaseSyncConflictRecoveryCurrent', () => {
  it('treats an unchanged pending recovery subtask as current', () => {
    expect(isBaseSyncConflictRecoveryCurrent(currentPlan(), files, reason, description)).toBe(true);
  });

  it('requires a nonterminal recovery subtask', () => {
    const plan = currentPlan({
      phases: [
        {
          subtasks: [
            {
              id: BASE_SYNC_RECOVERY_SUBTASK_ID,
              title: 'Resolve base branch sync conflicts',
              description,
              status: 'completed',
              verification: {
                type: 'command',
                run: 'git diff --name-only --diff-filter=U && git status --short',
              },
            },
          ],
        },
      ],
    });

    expect(isBaseSyncConflictRecoveryCurrent(plan, files, reason, description)).toBe(false);
  });

  it('detects changed conflict files', () => {
    expect(
      isBaseSyncConflictRecoveryCurrent(
        currentPlan(),
        ['packages/layer1-console/src/lib/data/index.ts'],
        reason,
        description,
      ),
    ).toBe(false);
  });
});
