import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { MergeOrchestrator, type MergeReport } from '../orchestrator';
import { MergeDecision } from '../types';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('MergeOrchestrator', () => {
  it('applies direct-copy file deletions from task worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merge-delete-'));
    const projectDir = join(root, 'project');
    const worktreeDir = join(root, 'worktree-delete');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await writeFile(join(projectDir, 'legacy.md'), '# Legacy\n');
      git(projectDir, ['add', 'legacy.md']);
      git(projectDir, ['commit', '-m', 'initial']);

      git(projectDir, ['worktree', 'add', '-b', 'auto-claude/001-delete', worktreeDir, 'main']);
      rmSync(join(worktreeDir, 'legacy.md'));
      git(worktreeDir, ['add', '-A']);
      git(worktreeDir, ['commit', '-m', 'delete legacy doc']);

      const orchestrator = new MergeOrchestrator({
        projectDir,
        storageDir: join(projectDir, '.auto-claude'),
        enableAi: false,
      });

      const report = await orchestrator.mergeTask('001-delete', worktreeDir, 'main');
      const deletion = report.fileResults.get('legacy.md');

      expect(report.success).toBe(true);
      expect(deletion?.deleteFile).toBe(true);
      expect(orchestrator.getApplicableFilePaths(report)).toEqual(['legacy.md']);
      expect(orchestrator.getStageableFilePaths(report)).toEqual(['legacy.md']);
      expect(existsSync(join(projectDir, 'legacy.md'))).toBe(true);

      expect(orchestrator.applyToProject(report)).toBe(true);
      expect(existsSync(join(projectDir, 'legacy.md'))).toBe(false);

      const alreadyGoneReport: MergeReport = {
        success: true,
        startedAt: new Date(),
        tasksMerged: ['001-delete'],
        stats: report.stats,
        fileResults: new Map([
          ['already-gone.md', {
            decision: MergeDecision.DIRECT_COPY,
            filePath: 'already-gone.md',
            deleteFile: true,
            conflictsResolved: [],
            conflictsRemaining: [],
            aiCallsMade: 0,
            tokensUsed: 0,
            explanation: 'Deletion already absent in target',
          }],
        ]),
      };
      expect(orchestrator.getApplicableFilePaths(alreadyGoneReport)).toEqual(['already-gone.md']);
      expect(orchestrator.getStageableFilePaths(alreadyGoneReport)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tracks untracked SQL files and clears stale task snapshots on refresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'merge-sql-refresh-'));
    const projectDir = join(root, 'project');
    const worktreeDir = join(root, 'worktree-sql');
    const storageDir = join(projectDir, '.auto-claude');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await writeFile(join(projectDir, 'README.md'), '# Project\n');
      git(projectDir, ['add', 'README.md']);
      git(projectDir, ['commit', '-m', 'initial']);

      git(projectDir, ['worktree', 'add', '-b', 'auto-claude/002-sql', worktreeDir, 'main']);
      await writeFile(join(worktreeDir, 'README.md'), '# Project\n\nStale retry text.\n');

      const first = new MergeOrchestrator({ projectDir, storageDir, enableAi: false });
      const staleReport = await first.mergeTask('002-sql', worktreeDir, 'main');
      expect(staleReport.success).toBe(true);
      expect(first.getApplicableFilePaths(staleReport)).toEqual(['README.md']);

      git(worktreeDir, ['checkout', '--', 'README.md']);
      await mkdir(join(worktreeDir, 'migrations'), { recursive: true });
      await writeFile(join(worktreeDir, 'migrations', '001_add_rpc.sql'), 'select 1;\n');

      const refreshed = new MergeOrchestrator({ projectDir, storageDir, enableAi: false });
      const report = await refreshed.mergeTask('002-sql', worktreeDir, 'main');

      expect(report.success).toBe(true);
      expect(refreshed.getApplicableFilePaths(report)).toEqual(['migrations/001_add_rpc.sql']);
      expect(refreshed.getStageableFilePaths(report)).toEqual(['migrations/001_add_rpc.sql']);

      expect(refreshed.applyToProject(report)).toBe(true);
      expect(readFileSync(join(projectDir, 'migrations', '001_add_rpc.sql'), 'utf8')).toBe('select 1;\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
