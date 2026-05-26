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
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { cp, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';

import { getSpecsDir } from '../../../shared/constants';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const LOCAL_ENV_FILES_TO_SYNC = [
  '.env.local',
  '.env',
  '.env.test',
  '.env.development.local',
];
const SPEC_SUPPORT_PATHS_TO_SYNC = [
  'QA_FIX_REQUEST.md',
  'QA_ESCALATION.md',
  'BASE_SYNC_CONFLICT.md',
  'qa_report.md',
  'feedback_images',
];
const YECT_LOCAL_TEST_DB_URL = 'postgresql://yect:yect@localhost:54329/yect_dev';
const DB_ENV_KEYS = new Set([
  'DATABASE_URL',
  'DATABASE_URL_DIRECT',
  'DATABASE_URL_TEST',
  'DATABASE_URL_TEST_DIRECT',
]);

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

async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', args, { cwd });
    return true;
  } catch {
    return false;
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

export interface WorktreeSyncResult {
  synced: boolean;
  stashed: boolean;
  conflicted?: boolean;
  conflictFiles?: string[];
  skippedReason?: string;
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
      await syncWorktreeWithBaseBranch(projectPath, worktreePath, baseBranch);
      await syncSpecDirectoryIntoWorktree(projectPath, worktreePath, specId, autoBuildPath);
      await syncLocalEnvFilesIntoWorktree(projectPath, worktreePath);
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
      const localExists = await git(
        ['rev-parse', '--verify', baseBranch],
        projectPath,
        /* allowFailure */ true,
      );
      if (localExists) {
        startPoint = baseBranch;
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
  await syncLocalEnvFilesIntoWorktree(projectPath, worktreePath);

  return { worktreePath: resolve(worktreePath), branch: branchName };
}

export async function syncWorktreeWithBaseBranch(
  projectPath: string,
  worktreePath: string,
  baseBranch = 'main',
): Promise<WorktreeSyncResult> {
  const baseExists = await git(
    ['rev-parse', '--verify', baseBranch],
    projectPath,
    /* allowFailure */ true,
  );
  if (!baseExists) {
    return { synced: false, stashed: false, skippedReason: `Base branch ${baseBranch} not found` };
  }

  const existingConflicts = await getUnmergedFiles(worktreePath);
  if (existingConflicts.length > 0) {
    return {
      synced: false,
      stashed: false,
      conflicted: true,
      conflictFiles: existingConflicts,
      skippedReason: 'worktree_has_unmerged_conflicts',
    };
  }

  const alreadyContainsBase = await gitSucceeds(
    ['merge-base', '--is-ancestor', baseBranch, 'HEAD'],
    worktreePath,
  );
  if (alreadyContainsBase) {
    return { synced: false, stashed: false, skippedReason: 'already_current' };
  }

  const dirty = await git(
    ['status', '--porcelain', '--', '.', ':(exclude).auto-claude'],
    worktreePath,
    /* allowFailure */ true,
  );
  let stashed = false;

  if (dirty.trim()) {
    const stashOutput = await git(
      [
        'stash',
        'push',
        '--include-untracked',
        '-m',
        `aperant-base-sync-${Date.now()}`,
        '--',
        '.',
        ':(exclude).auto-claude',
      ],
      worktreePath,
      /* allowFailure */ true,
    );
    stashed = !/No local changes/i.test(stashOutput);
  }

  try {
    const headIsAncestorOfBase = await gitSucceeds(
      ['merge-base', '--is-ancestor', 'HEAD', baseBranch],
      worktreePath,
    );
    if (headIsAncestorOfBase) {
      await git(['merge', '--ff-only', baseBranch], worktreePath);
    } else {
      await git(['merge', '--no-edit', baseBranch], worktreePath);
    }
  } catch (error) {
    await git(['merge', '--abort'], worktreePath, /* allowFailure */ true);
    if (stashed) {
      await git(['stash', 'pop'], worktreePath, /* allowFailure */ true);
    }
    throw error;
  }

  if (stashed) {
    await git(['stash', 'pop'], worktreePath, /* allowFailure */ true);
    const conflictFiles = await getUnmergedFiles(worktreePath);
    if (conflictFiles.length > 0) {
      return { synced: true, stashed, conflicted: true, conflictFiles };
    }
  }

  return { synced: true, stashed };
}

async function getUnmergedFiles(worktreePath: string): Promise<string[]> {
  const output = await git(
    ['diff', '--name-only', '--diff-filter=U'],
    worktreePath,
    /* allowFailure */ true,
  );
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
      throw new Error(
        `[WorktreeManager] Could not copy spec directory to worktree for ${specId}: ${message}`,
      );
    }

    const sourcePlanPath = join(sourceSpecDir, 'implementation_plan.json');
    const destPlanPath = join(destSpecDir, 'implementation_plan.json');
    if (existsSync(sourcePlanPath) && !existsSync(destPlanPath)) {
      throw new Error(
        `[WorktreeManager] Spec directory copy for ${specId} did not produce implementation_plan.json in the worktree`,
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

  await syncSpecSupportArtifactsIntoWorktree(sourceSpecDir, destSpecDir, specId);
}

async function syncSpecSupportArtifactsIntoWorktree(
  sourceSpecDir: string,
  destSpecDir: string,
  specId: string,
): Promise<void> {
  for (const relativePath of SPEC_SUPPORT_PATHS_TO_SYNC) {
    const sourcePath = join(sourceSpecDir, relativePath);
    if (!existsSync(sourcePath)) continue;

    const destPath = join(destSpecDir, relativePath);
    if (!shouldCopySpecSupportArtifact(sourcePath, destPath)) continue;

    try {
      mkdirSync(dirname(destPath), { recursive: true });
      await cp(sourcePath, destPath, { recursive: true, force: true });
      console.warn(
        `[WorktreeManager] Synced spec support artifact into worktree for ${specId}: ${relativePath}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] Warning: Could not sync spec support artifact ${relativePath} for ${specId}: ${message}`,
      );
    }
  }
}

function shouldCopySpecSupportArtifact(sourcePath: string, destPath: string): boolean {
  if (!existsSync(destPath)) return true;

  try {
    const sourceStat = statSync(sourcePath);
    const destStat = statSync(destPath);
    return sourceStat.mtimeMs > destStat.mtimeMs + 1;
  } catch {
    return false;
  }
}

async function syncLocalEnvFilesIntoWorktree(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  const copied: string[] = [];

  for (const filename of LOCAL_ENV_FILES_TO_SYNC) {
    const sourcePath = join(projectPath, filename);
    if (!existsSync(sourcePath)) continue;

    const destPath = join(worktreePath, filename);
    try {
      if (filename === '.env.local' && shouldUseYectLocalTestDb(projectPath)) {
        await writeFile(destPath, buildYectTaskEnvFile(readFileSync(sourcePath, 'utf-8')));
      } else {
        await cp(sourcePath, destPath, { force: true });
      }
      copied.push(filename);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] Warning: Could not sync ${filename} into task worktree: ${message}`,
      );
    }
  }

  if (copied.length > 0) {
    console.warn(
      `[WorktreeManager] Synced local env file(s) into task worktree: ${copied.join(', ')}`,
    );
  }
}

function shouldUseYectLocalTestDb(projectPath: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    return packageJson.name === 'yect'
      && packageJson.scripts?.['dev:db:up'] === 'node scripts/dev-db-up.mjs';
  } catch {
    return false;
  }
}

function buildYectTaskEnvFile(source: string): string {
  const preservedLines = source
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !match || !DB_ENV_KEYS.has(match[1]);
    });

  while (preservedLines.length > 0 && preservedLines[preservedLines.length - 1] === '') {
    preservedLines.pop();
  }

  return [
    ...preservedLines,
    '',
    '# Added by Aperant for isolated Yect task worktrees.',
    `DATABASE_URL=${YECT_LOCAL_TEST_DB_URL}`,
    `DATABASE_URL_DIRECT=${YECT_LOCAL_TEST_DB_URL}`,
    `DATABASE_URL_TEST=${YECT_LOCAL_TEST_DB_URL}`,
    `DATABASE_URL_TEST_DIRECT=${YECT_LOCAL_TEST_DB_URL}`,
    '',
  ].join('\n');
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
  const normalizedTarget = normalizeWorktreeListPath(worktreePath);
  return output
    .split(/\r?\n/)
    .some((line) => {
      if (!line.startsWith('worktree ')) return false;
      const listed = line.slice('worktree '.length).trim();
      return normalizeWorktreeListPath(listed) === normalizedTarget;
    });
}

function normalizeWorktreeListPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
