import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { MergeOrchestrator } from '../orchestrator';

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
      expect(existsSync(join(projectDir, 'legacy.md'))).toBe(true);

      expect(orchestrator.applyToProject(report)).toBe(true);
      expect(existsSync(join(projectDir, 'legacy.md'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
