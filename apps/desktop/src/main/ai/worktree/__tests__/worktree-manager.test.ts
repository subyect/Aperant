import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { createOrGetWorktree, syncWorktreeWithBaseBranch } from '../worktree-manager';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('syncWorktreeWithBaseBranch', () => {
  it('brings a dirty task worktree up to local main while preserving task edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worktree-sync-'));
    const projectDir = join(root, 'project');
    const worktreeDir = join(root, 'task-worktree');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await mkdir(join(projectDir, 'src'), { recursive: true });
      await writeFile(join(projectDir, 'src', 'shared.ts'), 'export const base = 1;\n');
      git(projectDir, ['add', 'src/shared.ts']);
      git(projectDir, ['commit', '-m', 'initial']);

      git(projectDir, ['worktree', 'add', '-b', 'auto-claude/sync-test', worktreeDir, 'main']);
      await writeFile(join(worktreeDir, 'src', 'task.ts'), 'export const task = true;\n');

      await mkdir(join(projectDir, 'src', 'data'), { recursive: true });
      await writeFile(join(projectDir, 'src', 'data', 'index.ts'), 'export const fromMain = true;\n');
      git(projectDir, ['add', 'src/data/index.ts']);
      git(projectDir, ['commit', '-m', 'advance main']);

      const result = await syncWorktreeWithBaseBranch(projectDir, worktreeDir, 'main');

      expect(result.synced).toBe(true);
      expect(result.stashed).toBe(true);
      expect(existsSync(join(worktreeDir, 'src', 'data', 'index.ts'))).toBe(true);
      expect(readFileSync(join(worktreeDir, 'src', 'task.ts'), 'utf8')).toContain('task = true');
      expect(git(worktreeDir, ['status', '--short', '--', 'src/task.ts'])).toContain('?? src/task.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports files that conflict while restoring task edits after base sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worktree-sync-conflict-'));
    const projectDir = join(root, 'project');
    const worktreeDir = join(root, 'task-worktree');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await mkdir(join(projectDir, 'src'), { recursive: true });
      await writeFile(join(projectDir, 'src', 'shared.ts'), 'export const value = "base";\n');
      git(projectDir, ['add', 'src/shared.ts']);
      git(projectDir, ['commit', '-m', 'initial']);

      git(projectDir, ['worktree', 'add', '-b', 'auto-claude/conflict-test', worktreeDir, 'main']);
      await writeFile(join(worktreeDir, 'src', 'shared.ts'), 'export const value = "task";\n');

      await writeFile(join(projectDir, 'src', 'shared.ts'), 'export const value = "main";\n');
      git(projectDir, ['add', 'src/shared.ts']);
      git(projectDir, ['commit', '-m', 'advance main']);

      const result = await syncWorktreeWithBaseBranch(projectDir, worktreeDir, 'main');

      expect(result.synced).toBe(true);
      expect(result.stashed).toBe(true);
      expect(result.conflicted).toBe(true);
      expect(result.conflictFiles).toEqual(['src/shared.ts']);
      expect(git(worktreeDir, ['diff', '--name-only', '--diff-filter=U'])).toBe('src/shared.ts');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('createOrGetWorktree local env sync', () => {
  it('copies root local env files into a new task worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worktree-env-'));
    const projectDir = join(root, 'project');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await writeFile(join(projectDir, 'README.md'), '# test\n');
      git(projectDir, ['add', 'README.md']);
      git(projectDir, ['commit', '-m', 'initial']);

      await writeFile(join(projectDir, '.env.local'), 'DATABASE_URL=postgres://local\n');

      const result = await createOrGetWorktree(
        projectDir,
        '001-env-copy',
        'main',
        true,
        false,
      );

      expect(readFileSync(join(result.worktreePath, '.env.local'), 'utf8')).toBe(
        'DATABASE_URL=postgres://local\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes root local env files when reusing a registered task worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worktree-env-reuse-'));
    const projectDir = join(root, 'project');

    try {
      git(root, ['init', '-b', 'main', projectDir]);
      git(projectDir, ['config', 'user.email', 'test@example.com']);
      git(projectDir, ['config', 'user.name', 'Test User']);

      await writeFile(join(projectDir, 'README.md'), '# test\n');
      git(projectDir, ['add', 'README.md']);
      git(projectDir, ['commit', '-m', 'initial']);

      await writeFile(join(projectDir, '.env.local'), 'DATABASE_URL=postgres://old\n');
      const first = await createOrGetWorktree(
        projectDir,
        '002-env-refresh',
        'main',
        true,
        false,
      );

      await writeFile(join(projectDir, '.env.local'), 'DATABASE_URL=postgres://new\n');
      const second = await createOrGetWorktree(
        projectDir,
        '002-env-refresh',
        'main',
        true,
        false,
      );

      expect(second.worktreePath).toBe(first.worktreePath);
      expect(readFileSync(join(second.worktreePath, '.env.local'), 'utf8')).toBe(
        'DATABASE_URL=postgres://new\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
