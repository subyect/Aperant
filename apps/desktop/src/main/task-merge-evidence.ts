import { execFileSync } from 'child_process';
import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';

export interface TaskMergeEvidence {
  commitSha: string;
  mergedAt: string;
  source: 'plan-commit' | 'auto-merge-commit';
}

type PlanLike = Record<string, unknown> | null | undefined;

function getReachableCommitInfo(projectPath: string, revision: string): { commitSha: string; mergedAt: string } | null {
  const trimmed = revision.trim();
  if (!trimmed) return null;

  try {
    const commitSha = execFileSync(getToolPath('git'), ['rev-parse', '--verify', `${trimmed}^{commit}`], {
      cwd: projectPath,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    execFileSync(getToolPath('git'), ['merge-base', '--is-ancestor', commitSha, 'HEAD'], {
      cwd: projectPath,
      env: getIsolatedGitEnv(),
      stdio: 'ignore',
    });

    const mergedAt = execFileSync(getToolPath('git'), ['show', '-s', '--format=%cI', commitSha], {
      cwd: projectPath,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return { commitSha, mergedAt };
  } catch {
    return null;
  }
}

function findReachableAutoMergeCommit(projectPath: string, specId: string): { commitSha: string; mergedAt: string } | null {
  try {
    const output = execFileSync(getToolPath('git'), [
      'log',
      '-n',
      '1',
      '--format=%H%x09%cI%x09%s',
      '--fixed-strings',
      `--grep=Auto-merge ${specId}:`,
      'HEAD',
    ], {
      cwd: projectPath,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (!output) return null;
    const [commitSha, mergedAt] = output.split('\t');
    if (!commitSha || !mergedAt) return null;
    return { commitSha, mergedAt };
  } catch {
    return null;
  }
}

export function findReachableTaskMergeEvidence({
  projectPath,
  specId,
  plan,
}: {
  projectPath: string;
  specId: string;
  plan?: PlanLike;
}): TaskMergeEvidence | null {
  const planCommit = typeof plan?.mergeCommit === 'string' ? plan.mergeCommit : '';
  const planEvidence = getReachableCommitInfo(projectPath, planCommit);
  if (planEvidence) {
    return { ...planEvidence, source: 'plan-commit' };
  }

  const autoMergeEvidence = findReachableAutoMergeCommit(projectPath, specId);
  if (autoMergeEvidence) {
    return { ...autoMergeEvidence, source: 'auto-merge-commit' };
  }

  return null;
}
