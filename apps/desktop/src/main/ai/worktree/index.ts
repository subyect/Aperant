/**
 * Worktree module — public API
 *
 * Re-exports the createOrGetWorktree function and its return type so
 * consumers can import from the worktree directory without referencing
 * internal file names.
 */

export { createOrGetWorktree, syncWorktreeWithBaseBranch } from './worktree-manager';
export type { WorktreeResult, WorktreeSyncResult } from './worktree-manager';
