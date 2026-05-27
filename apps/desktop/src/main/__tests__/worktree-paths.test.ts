import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_WORKTREE_DIR,
  findTaskWorktree,
  isValidTaskWorktree,
} from '../worktree-paths';

const git = 'git';

function runGit(cwd: string, args: string[]): string {
  return execFileSync(git, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HUSKY: '0' },
  }).trim();
}

function createRepo(): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'aperant-worktree-paths-'));
  runGit(repoPath, ['init', '-b', 'main']);
  writeFileSync(path.join(repoPath, '.gitignore'), '.auto-claude/\n');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  runGit(repoPath, ['add', '.gitignore', 'README.md']);
  runGit(repoPath, [
    '-c',
    'user.name=Aperant Test',
    '-c',
    'user.email=aperant-test@example.com',
    'commit',
    '-m',
    'initial',
  ]);
  return repoPath;
}

describe('worktree path validation', () => {
  const createdRepos: string[] = [];

  afterEach(() => {
    for (const repoPath of createdRepos.splice(0)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('rejects stale task folders that resolve git commands to the main checkout', () => {
    const repoPath = createRepo();
    createdRepos.push(repoPath);
    const specId = '026-push-obyect-tag-filtering-into-a-server-side-sql-r';
    const stalePath = path.join(repoPath, TASK_WORKTREE_DIR, specId);
    mkdirSync(stalePath, { recursive: true });

    expect(isValidTaskWorktree(repoPath, specId, stalePath)).toBe(false);
    expect(findTaskWorktree(repoPath, specId)).toBeNull();
  });

  it('accepts registered task worktrees on the expected auto-claude branch', () => {
    const repoPath = createRepo();
    createdRepos.push(repoPath);
    const specId = '001-valid-worktree';
    const worktreePath = path.join(repoPath, TASK_WORKTREE_DIR, specId);

    runGit(repoPath, ['worktree', 'add', '-b', `auto-claude/${specId}`, worktreePath, 'HEAD']);

    expect(isValidTaskWorktree(repoPath, specId, worktreePath)).toBe(true);
    expect(findTaskWorktree(repoPath, specId)).toBe(path.resolve(worktreePath));
  });
});
