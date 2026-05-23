/**
 * Worktree Manager
 * ================
 *
 * TypeScript replacement for the Python WorktreeManager.create_worktree()
 * See apps/desktop/src/main/ai/worktree/worktree-manager.ts for the TypeScript implementation.
 *
 * Creates and manages git worktrees for autonomous task execution.
 * Each task runs in an isolated worktree at:
 *   {projectPath}/.auto-claude/worktrees/tasks/{specId}/
 * on branch:
 *   auto-claude/{specId}
 *
 * The function is idempotent — calling it repeatedly with the same specId
 * returns the existing worktree without error.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { cp, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';

import { getSpecsDir } from '../../../shared/constants';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/**
 * Run a git sub-command in the given working directory.
 * Returns stdout on success, throws on non-zero exit (unless `allowFailure` is
 * set to true, in which case an empty string is returned instead of throwing).
 */
async function git(
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch (err: unknown) {
    if (allowFailure) {
      return '';
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorktreeResult {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Git branch name checked out in the worktree */
  branch: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Create or return an existing git worktree for the given spec.
 *
 * Mirrors WorktreeManager.create_worktree() from the Python backend.
 *
 * @param projectPath    Absolute path to the project root (git repo)
 * @param specId         Spec folder name, e.g. "001-my-feature"
 * @param baseBranch     Base branch to branch from (defaults to "main")
 * @param useLocalBranch If true, always use the local base branch instead of
 *                       the remote ref (preserves gitignored files)
 * @param pushNewBranches If true, push the branch to origin and set upstream
 *                        tracking after worktree creation. Defaults to true.
 * @param autoBuildPath  Optional custom data directory (e.g. ".auto-claude").
 *                       Passed to getSpecsDir() for spec-copy logic.
 */
export async function createOrGetWorktree(
  projectPath: string,
  specId: string,
  baseBranch = 'main',
  useLocalBranch = false,
  pushNewBranches = true,
  autoBuildPath?: string,
): Promise<WorktreeResult> {
  const worktreePath = join(projectPath, '.auto-claude/worktrees/tasks', specId);
  const branchName = `auto-claude/${specId}`;

  // ------------------------------------------------------------------
  // Step 1: Prune stale worktree references from git's internal records
  // ------------------------------------------------------------------
  console.warn('[WorktreeManager] Pruning stale worktree references...');
  await git(['worktree', 'prune'], projectPath, /* allowFailure */ true);

  // ------------------------------------------------------------------
  // Step 2: Return early when worktree already exists and is registered
  // ------------------------------------------------------------------
  if (existsSync(worktreePath)) {
    const isRegistered = await isWorktreeRegistered(worktreePath, projectPath);

    if (isRegistered) {
      console.warn(
        `[WorktreeManager] Using existing worktree: ${specId} on branch ${branchName}`,
      );
      await syncSpecDirectoryIntoWorktree(projectPath, worktreePath, specId, autoBuildPath);
      return { worktreePath: resolve(worktreePath), branch: branchName };
    }

    // ------------------------------------------------------------------
    // Step 3: Remove stale directory that git no longer tracks
    // ------------------------------------------------------------------
    console.warn(
      `[WorktreeManager] Removing stale worktree directory: ${specId}`,
    );
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[WorktreeManager] Failed to remove stale worktree directory at ${worktreePath}: ${message}`,
      );
    }

    if (existsSync(worktreePath)) {
      throw new Error(
        `[WorktreeManager] Stale worktree directory still exists after removal: ${worktreePath}. ` +
          'This may be due to permission issues or file locks.',
      );
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Check whether the target branch already exists locally
  // ------------------------------------------------------------------
  const branchListOutput = await git(
    ['branch', '--list', branchName],
    projectPath,
    /* allowFailure */ true,
  );
  const branchExists = branchListOutput.includes(branchName);

  // ------------------------------------------------------------------
  // Step 5: Fetch latest from remote (non-fatal — remote may not exist)
  // ------------------------------------------------------------------
  console.warn(
    `[WorktreeManager] Fetching latest from origin/${baseBranch}...`,
  );
  // git fetch stdout is empty on success — result is intentionally unused
  await git(
    ['fetch', 'origin', baseBranch],
    projectPath,
    /* allowFailure */ true,
  );

  // ------------------------------------------------------------------
  // Step 6: Create the worktree
  // ------------------------------------------------------------------
  if (branchExists) {
    // Branch already exists — attach the worktree to it without -b
    console.warn(`[WorktreeManager] Reusing existing branch: ${branchName}`);
    await git(
      ['worktree', 'add', worktreePath, branchName],
      projectPath,
    );
  } else {
    // Determine the start point
    let startPoint = baseBranch;

    if (useLocalBranch) {
      console.warn(
        `[WorktreeManager] Creating worktree from local branch: ${baseBranch}`,
      );
    } else {
      const remoteRef = `origin/${baseBranch}`;
      const remoteExists = await git(
        ['rev-parse', '--verify', remoteRef],
        projectPath,
        /* allowFailure */ true,
      );

      if (remoteExists) {
        startPoint = remoteRef;
        console.warn(
          `[WorktreeManager] Creating worktree from remote: ${remoteRef}`,
        );
      } else {
        console.warn(
          `[WorktreeManager] Remote ref ${remoteRef} not found, using local branch: ${baseBranch}`,
        );
      }
    }

    await git(
      ['worktree', 'add', '-b', branchName, '--no-track', worktreePath, startPoint],
      projectPath,
    );
  }

  console.warn(
    `[WorktreeManager] Created worktree: ${specId} on branch ${branchName}`,
  );

  // Best-effort upstream setup: the remote branch does not exist until first push,
  // so publish it here when origin is available instead of inheriting origin/main.
  if (pushNewBranches) {
    const hasOrigin = await git(
      ['remote', 'get-url', 'origin'],
      projectPath,
      /* allowFailure */ true,
    );

    if (hasOrigin) {
      try {
        await git(
          ['push', '--set-upstream', 'origin', branchName],
          worktreePath,
        );
        console.warn(
          `[WorktreeManager] Pushed and set upstream: origin/${branchName}`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[WorktreeManager] Warning: Could not push upstream for ${branchName}: ${message}`,
        );
      }
    }
  } else {
    console.warn(
      `[WorktreeManager] Leaving branch local-only (auto-push disabled): ${branchName}`,
    );
  }

  await syncSpecDirectoryIntoWorktree(projectPath, worktreePath, specId, autoBuildPath);

  return { worktreePath: resolve(worktreePath), branch: branchName };
}

async function syncSpecDirectoryIntoWorktree(
  projectPath: string,
  worktreePath: string,
  specId: string,
  autoBuildPath?: string,
): Promise<void> {
  // .auto-claude/specs/ is gitignored, so worktrees need a private copy.
  // Existing worktrees also need repair: a prior failed run may contain an
  // empty implementation_plan.json while the main spec has since been replanned.
  const specsRelDir = getSpecsDir(autoBuildPath);
  const sourceSpecDir = join(projectPath, specsRelDir, specId);
  const destSpecDir = join(worktreePath, specsRelDir, specId);

  if (!existsSync(sourceSpecDir)) return;

  if (!existsSync(destSpecDir)) {
    console.warn(
      `[WorktreeManager] Copying spec directory into worktree: ${specsRelDir}/${specId}`,
    );

    mkdirSync(dirname(destSpecDir), { recursive: true });
    try {
      await cp(sourceSpecDir, destSpecDir, { recursive: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] Warning: Could not copy spec directory to worktree: ${message}`,
      );
    }
    return;
  }

  const sourcePlanPath = join(sourceSpecDir, 'implementation_plan.json');
  const destPlanPath = join(destSpecDir, 'implementation_plan.json');
  const sourceCount = countPlanSubtasks(sourcePlanPath);
  const destCount = countPlanSubtasks(destPlanPath);
  if (sourceCount > 0 && destCount === 0) {
    try {
      await cp(sourcePlanPath, destPlanPath, { force: true });
      console.warn(
        `[WorktreeManager] Repaired stale worktree plan for ${specId}: copied ${sourceCount} subtask(s) from main spec`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] Warning: Could not repair worktree plan for ${specId}: ${message}`,
      );
    }
  }
}

function countPlanSubtasks(planPath: string): number {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as { phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }> };
    return Array.isArray(plan.phases)
      ? plan.phases.reduce((count, phase) => {
          const items = Array.isArray(phase.subtasks)
            ? phase.subtasks
            : Array.isArray(phase.chunks)
              ? phase.chunks
              : [];
          return count + items.length;
        }, 0)
      : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Returns true when the given path appears in `git worktree list --porcelain`
 * output, meaning git knows about this worktree.
 */
async function isWorktreeRegistered(
  worktreePath: string,
  projectPath: string,
): Promise<boolean> {
  const output = await git(
    ['worktree', 'list', '--porcelain'],
    projectPath,
    /* allowFailure */ true,
  );

  if (!output) return false;

  // Each entry starts with "worktree <absolute-path>"
  const normalizedTarget = resolve(worktreePath);
  return output
    .split(/\r?\n/)
    .some((line) => {
      if (!line.startsWith('worktree ')) return false;
      const listed = line.slice('worktree '.length).trim();
      return resolve(listed) === normalizedTarget;
    });
}
