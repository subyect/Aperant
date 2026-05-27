/**
 * Shared worktree path utilities
 *
 * Centralizes all worktree path constants and helper functions to avoid duplication
 * and ensure consistent path handling across the application.
 */

import path from 'path';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';

// Path constants for worktree directories
export const TASK_WORKTREE_DIR = '.auto-claude/worktrees/tasks';
export const TERMINAL_WORKTREE_DIR = '.auto-claude/worktrees/terminal';

// Metadata directories (separate from git worktrees to avoid uncommitted files)
export const TERMINAL_WORKTREE_METADATA_DIR = '.auto-claude/terminal/metadata';

// Legacy path for backwards compatibility
export const LEGACY_WORKTREE_DIR = '.worktrees';

/**
 * Get the task worktrees directory path
 */
export function getTaskWorktreeDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTaskWorktreeDir: projectPath is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TASK_WORKTREE_DIR);
}

/**
 * Get the full path for a specific task worktree
 */
export function getTaskWorktreePath(projectPath: string, specId: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTaskWorktreePath: projectPath is undefined or not a string');
    return '';
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[worktree-paths] getTaskWorktreePath: specId is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TASK_WORKTREE_DIR, specId);
}

/**
 * Validate that a resolved path is within the expected base directory
 * Protects against path traversal attacks (e.g., specId containing "..")
 */
export function isPathWithinBase(resolvedPath: string, basePath: string): boolean {
  const normalizedPath = path.resolve(resolvedPath);
  const normalizedBase = path.resolve(basePath);
  return normalizedPath.startsWith(normalizedBase + path.sep) || normalizedPath === normalizedBase;
}

function getRealPath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync(getToolPath('git'), args, {
      cwd,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export interface RegisteredWorktreeInfo {
  branch: string | null;
  prunable: boolean;
}

interface RegisteredWorktreeCacheEntry {
  expiresAt: number;
  worktrees: Map<string, RegisteredWorktreeInfo>;
}

const REGISTERED_WORKTREE_CACHE_TTL_MS = 2_000;
const registeredWorktreeCache = new Map<string, RegisteredWorktreeCacheEntry>();

function normalizeWorktreeBranch(branchRef: string): string | null {
  const branch = branchRef.trim();
  if (!branch) return null;
  return branch.replace(/^refs\/heads\//, '');
}

function getCacheKey(projectPath: string): string {
  return getRealPath(projectPath) ?? path.resolve(projectPath);
}

export function clearWorktreePathCache(projectPath?: string): void {
  if (!projectPath) {
    registeredWorktreeCache.clear();
    return;
  }
  registeredWorktreeCache.delete(getCacheKey(projectPath));
}

export function getRegisteredWorktreeInfoMap(projectPath: string): ReadonlyMap<string, RegisteredWorktreeInfo> {
  const cacheKey = getCacheKey(projectPath);
  const cached = registeredWorktreeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.worktrees;
  }

  const output = gitOutput(projectPath, ['worktree', 'list', '--porcelain']);
  const worktrees = new Map<string, RegisteredWorktreeInfo>();
  if (!output) {
    registeredWorktreeCache.set(cacheKey, {
      expiresAt: Date.now() + REGISTERED_WORKTREE_CACHE_TTL_MS,
      worktrees,
    });
    return worktrees;
  }

  let currentPath: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      const worktreePath = line.slice('worktree '.length).trim();
      currentPath = getRealPath(worktreePath) ?? path.resolve(worktreePath);
      worktrees.set(currentPath, { branch: null, prunable: false });
      continue;
    }

    if (!currentPath) continue;
    const info = worktrees.get(currentPath);
    if (!info) continue;
    if (line.startsWith('branch ')) {
      info.branch = normalizeWorktreeBranch(line.slice('branch '.length));
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      info.prunable = true;
    } else if (line.trim() === '') {
      currentPath = null;
    }
  }

  registeredWorktreeCache.set(cacheKey, {
    expiresAt: Date.now() + REGISTERED_WORKTREE_CACHE_TTL_MS,
    worktrees,
  });
  return worktrees;
}

export function getRegisteredWorktreePaths(projectPath: string): Set<string> {
  return new Set(getRegisteredWorktreeInfoMap(projectPath).keys());
}

/**
 * Validate that a task path is a real registered git worktree for this spec.
 *
 * A stale directory under .auto-claude/worktrees/tasks can otherwise make git walk
 * up to the main checkout and report the main repo as the task worktree.
 */
export function isValidTaskWorktree(
  projectPath: string,
  specId: string,
  candidatePath: string,
  registeredWorktrees = getRegisteredWorktreeInfoMap(projectPath)
): boolean {
  if (!existsSync(candidatePath)) return false;

  const projectRealPath = getRealPath(projectPath) ?? path.resolve(projectPath);
  const candidateRealPath = getRealPath(candidatePath) ?? path.resolve(candidatePath);
  if (candidateRealPath === projectRealPath) return false;
  if (!isPathWithinBase(candidateRealPath, projectRealPath)) return false;

  const expectedBranch = `auto-claude/${specId}`;
  const registeredInfo = registeredWorktrees.get(candidateRealPath);
  if (!registeredInfo || registeredInfo.prunable) return false;
  if (registeredInfo.branch !== expectedBranch) return false;

  return true;
}

/**
 * Find a task worktree path, checking new location first then legacy
 * Returns the path if found, null otherwise
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTaskWorktree(projectPath: string, specId: string): string | null {
  // Defensive check for undefined inputs
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] findTaskWorktree: projectPath is undefined or not a string');
    return null;
  }
  if (!specId || typeof specId !== 'string') {
    console.error('[worktree-paths] findTaskWorktree: specId is undefined or not a string');
    return null;
  }

  const normalizedProject = path.resolve(projectPath);

  // Check new path first
  const newPath = path.join(projectPath, TASK_WORKTREE_DIR, specId);
  const resolvedNewPath = path.resolve(newPath);

  // Validate path stays within project (defense against path traversal)
  if (!isPathWithinBase(resolvedNewPath, normalizedProject)) {
    console.error(`[worktree-paths] Path traversal detected: specId "${specId}" resolves outside project`);
    return null;
  }

  if (isValidTaskWorktree(projectPath, specId, resolvedNewPath)) return resolvedNewPath;

  // Legacy fallback
  const legacyPath = path.join(projectPath, LEGACY_WORKTREE_DIR, specId);
  const resolvedLegacyPath = path.resolve(legacyPath);

  // Validate legacy path as well
  if (!isPathWithinBase(resolvedLegacyPath, normalizedProject)) {
    console.error(`[worktree-paths] Path traversal detected: specId "${specId}" resolves outside project (legacy)`);
    return null;
  }

  if (isValidTaskWorktree(projectPath, specId, resolvedLegacyPath)) return resolvedLegacyPath;

  return null;
}

/**
 * Get the terminal worktrees directory path
 */
export function getTerminalWorktreeDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeDir: projectPath is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TERMINAL_WORKTREE_DIR);
}

/**
 * Get the full path for a specific terminal worktree
 */
export function getTerminalWorktreePath(projectPath: string, name: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreePath: projectPath is undefined or not a string');
    return '';
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreePath: name is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TERMINAL_WORKTREE_DIR, name);
}

/**
 * Find a terminal worktree path, checking new location first then legacy
 * Returns the path if found, null otherwise
 * Includes path traversal protection to ensure paths stay within project
 */
export function findTerminalWorktree(projectPath: string, name: string): string | null {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] findTerminalWorktree: projectPath is undefined or not a string');
    return null;
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] findTerminalWorktree: name is undefined or not a string');
    return null;
  }

  const normalizedProject = path.resolve(projectPath);

  // Check new path first
  const newPath = path.join(projectPath, TERMINAL_WORKTREE_DIR, name);
  const resolvedNewPath = path.resolve(newPath);

  // Validate path stays within project (defense against path traversal)
  if (!isPathWithinBase(resolvedNewPath, normalizedProject)) {
    console.error(`[worktree-paths] Path traversal detected: name "${name}" resolves outside project`);
    return null;
  }

  if (existsSync(resolvedNewPath)) return resolvedNewPath;

  // Legacy fallback (terminal worktrees used terminal-{name} prefix)
  const legacyPath = path.join(projectPath, LEGACY_WORKTREE_DIR, `terminal-${name}`);
  const resolvedLegacyPath = path.resolve(legacyPath);

  // Validate legacy path as well
  if (!isPathWithinBase(resolvedLegacyPath, normalizedProject)) {
    console.error(`[worktree-paths] Path traversal detected: name "${name}" resolves outside project (legacy)`);
    return null;
  }

  if (existsSync(resolvedLegacyPath)) return resolvedLegacyPath;

  return null;
}

/**
 * Get the terminal worktree metadata directory path
 * This is separate from the git worktree to avoid uncommitted files
 */
export function getTerminalWorktreeMetadataDir(projectPath: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataDir: projectPath is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TERMINAL_WORKTREE_METADATA_DIR);
}

/**
 * Get the metadata file path for a specific terminal worktree
 */
export function getTerminalWorktreeMetadataPath(projectPath: string, name: string): string {
  if (!projectPath || typeof projectPath !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataPath: projectPath is undefined or not a string');
    return '';
  }
  if (!name || typeof name !== 'string') {
    console.error('[worktree-paths] getTerminalWorktreeMetadataPath: name is undefined or not a string');
    return '';
  }
  return path.join(projectPath, TERMINAL_WORKTREE_METADATA_DIR, `${name}.json`);
}
