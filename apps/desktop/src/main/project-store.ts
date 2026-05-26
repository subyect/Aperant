import { app } from 'electron';
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, Dirent } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Project, ProjectSettings, Task, TaskStatus, TaskMetadata, ImplementationPlan, ReviewReason, PlanSubtask, KanbanPreferences, ExecutionPhase } from '../shared/types';
import {
  DEFAULT_PROJECT_SETTINGS,
  AUTO_BUILD_PATHS,
  getSpecsDir,
  JSON_ERROR_PREFIX,
  JSON_ERROR_TITLE_SUFFIX,
  TASK_STATUS_PRIORITY,
  normalizeOpenAISubscriptionModel,
} from '../shared/constants';
import { getAutoBuildPath, isInitialized } from './project-initializer';
import { getTaskWorktreeDir } from './worktree-paths';
import { getToolPath } from './cli-tool-manager';
import { findAllSpecPaths } from './utils/spec-path-helpers';
import { ensureAbsolutePath } from './utils/path-helpers';
import { writeFileAtomicSync } from './utils/atomic-file';
import { updateRoadmapFeatureOutcome, revertRoadmapFeatureOutcome } from './utils/roadmap-utils';
import { safeParseJson } from './utils/json-repair';
import { getIsolatedGitEnv } from './utils/git-isolation';
import { BASE_SYNC_RECOVERY_NOTE, BASE_SYNC_RECOVERY_SUBTASK_ID } from './agent/base-sync-recovery';
import { getQaReportVerdictFromContent } from './agent/task-review-artifacts';
import { findReachableTaskMergeEvidence, type TaskMergeEvidence } from './task-merge-evidence';
import {
  applyRuntimePhaseState,
  checkSubtasksCompletion,
  clearCompletedSubtaskDiagnostics,
  clearResolvedRecoveryState,
  doneStatusHasIncompleteSubtasks,
  hasResolvedRecoverySubtasks,
  isQASignoffApproved,
  planHasMergeCompletionEvidence,
  statusRequiresCompletedSubtasks,
} from './task-plan-guards';
import { XSTATE_ACTIVE_STATES, XSTATE_TO_PHASE } from '../shared/state-machines';



interface TabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

interface StoreData {
  projects: Project[];
  settings: Record<string, unknown>;
  tabState?: TabState;
  kanbanPreferences?: Record<string, KanbanPreferences>;
}

interface TasksCacheEntry {
  tasks: Task[];
  timestamp: number;
}

/**
 * Persistent storage for projects and settings
 */
export class ProjectStore {
  private storePath: string;
  private data: StoreData;
  private tasksCache: Map<string, TasksCacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 3000; // 3 seconds TTL for task cache

  constructor() {
    // Store in app's userData directory
    const userDataPath = app.getPath('userData');
    const storeDir = path.join(userDataPath, 'store');

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }

    this.storePath = path.join(storeDir, 'projects.json');
    this.data = this.load();
  }

  /**
   * Load store from disk
   */
  private load(): StoreData {
    if (existsSync(this.storePath)) {
      try {
        const content = readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(content);
        let needsSave = false;
        // Convert date strings back to Date objects and normalize paths to absolute
        data.projects = data.projects.map((p: Project) => {
          const original = p.settings?.model;
          const normalized = normalizeOpenAISubscriptionModel(original ?? DEFAULT_PROJECT_SETTINGS.model);
          const changed = normalized !== original;
          if (normalized !== original) {
            needsSave = true;
          }
          return {
            ...p,
            // Ensure project.path is always absolute (critical for dev mode path resolution)
            path: ensureAbsolutePath(p.path),
            settings: {
              ...DEFAULT_PROJECT_SETTINGS,
              ...(p.settings ?? {}),
              model: normalized,
            },
            createdAt: new Date(p.createdAt),
            updatedAt: changed ? new Date() : new Date(p.updatedAt)
          };
        });
        if (needsSave) {
          writeFileAtomicSync(this.storePath, JSON.stringify(data, null, 2));
        }
        return data;
      } catch {
        return { projects: [], settings: {} };
      }
    }
    return { projects: [], settings: {} };
  }

  /**
   * Save store to disk
   */
  private save(): void {
    writeFileAtomicSync(this.storePath, JSON.stringify(this.data, null, 2));
  }

  /**
   * Add a new project
   */
  addProject(projectPath: string, name?: string): Project {
    // CRITICAL: Normalize to absolute path for dev mode compatibility
    // This prevents path resolution issues after app restart
    const absolutePath = ensureAbsolutePath(projectPath);

    // Check if project already exists (using absolute path for comparison)
    const existing = this.data.projects.find((p) => p.path === absolutePath);
    if (existing) {
      // Validate that .auto-claude folder still exists for existing project
      // If manually deleted, reset autoBuildPath so UI prompts for reinitialization
      if (existing.autoBuildPath && !isInitialized(existing.path)) {
        console.warn(`[ProjectStore] .auto-claude folder was deleted for project "${existing.name}" - resetting autoBuildPath`);
        existing.autoBuildPath = '';
        existing.updatedAt = new Date();
        this.save();
      }
      return existing;
    }

    // Derive name from path if not provided
    const projectName = name || path.basename(absolutePath);

    // Determine auto-claude path (supports both 'auto-claude' and '.auto-claude')
    const autoBuildPath = getAutoBuildPath(absolutePath) || '';

    const project: Project = {
      id: uuidv4(),
      name: projectName,
      path: absolutePath, // Store absolute path
      autoBuildPath,
      settings: { ...DEFAULT_PROJECT_SETTINGS },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.data.projects.push(project);
    this.save();

    return project;
  }

  /**
   * Update project's autoBuildPath after initialization
   */
  updateAutoBuildPath(projectId: string, autoBuildPath: string): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.autoBuildPath = autoBuildPath;
      project.updatedAt = new Date();
      this.save();
    }
    return project;
  }

  /**
   * Remove a project
   */
  removeProject(projectId: string): boolean {
    const index = this.data.projects.findIndex((p) => p.id === projectId);
    if (index !== -1) {
      this.data.projects.splice(index, 1);
      // Clean up kanban preferences to avoid orphaned data
      if (this.data.kanbanPreferences?.[projectId]) {
        delete this.data.kanbanPreferences[projectId];
      }
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Get all projects
   */
  getProjects(): Project[] {
    return this.data.projects;
  }

  /**
   * Get tab state
   */
  getTabState(): TabState {
    return this.data.tabState || {
      openProjectIds: [],
      activeProjectId: null,
      tabOrder: []
    };
  }

  /**
   * Save tab state
   */
  saveTabState(tabState: TabState): void {
    // Filter out any project IDs that no longer exist
    const validProjectIds = this.data.projects.map(p => p.id);
    this.data.tabState = {
      openProjectIds: tabState.openProjectIds.filter(id => validProjectIds.includes(id)),
      activeProjectId: tabState.activeProjectId && validProjectIds.includes(tabState.activeProjectId)
        ? tabState.activeProjectId
        : null,
      tabOrder: tabState.tabOrder.filter(id => validProjectIds.includes(id))
    };
    this.save();
  }

  /**
   * Get kanban column preferences for a specific project
   */
  getKanbanPreferences(projectId: string): KanbanPreferences | null {
    return this.data.kanbanPreferences?.[projectId] ?? null;
  }

  /**
   * Save kanban column preferences for a specific project
   */
  saveKanbanPreferences(projectId: string, preferences: KanbanPreferences): void {
    if (!this.data.kanbanPreferences) {
      this.data.kanbanPreferences = {};
    }
    this.data.kanbanPreferences[projectId] = preferences;
    this.save();
  }

  /**
   * Validate all projects to ensure their .auto-claude folders still exist.
   * If a project has autoBuildPath set but the folder was deleted,
   * reset autoBuildPath to empty string so the UI prompts for reinitialization.
   *
   * @returns Array of project IDs that were reset due to missing .auto-claude folder
   */
  validateProjects(): string[] {
    const resetProjectIds: string[] = [];
    let hasChanges = false;

    for (const project of this.data.projects) {
      // Skip projects that aren't initialized (autoBuildPath is empty)
      if (!project.autoBuildPath) {
        continue;
      }

      // Check if the project path still exists
      if (!existsSync(project.path)) {
        console.warn(`[ProjectStore] Project path no longer exists: ${project.path}`);
        continue; // Don't reset - let user handle this case
      }

      // Check if .auto-claude folder still exists
      if (!isInitialized(project.path)) {
        console.warn(`[ProjectStore] .auto-claude folder missing for project "${project.name}" at ${project.path}`);
        project.autoBuildPath = '';
        project.updatedAt = new Date();
        resetProjectIds.push(project.id);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.save();
      console.warn(`[ProjectStore] Reset ${resetProjectIds.length} project(s) due to missing .auto-claude folder`);
    }

    return resetProjectIds;
  }

  /**
   * Get a project by ID
   */
  getProject(projectId: string): Project | undefined {
    return this.data.projects.find((p) => p.id === projectId);
  }

  /**
   * Update project settings
   */
  updateProjectSettings(
    projectId: string,
    settings: Partial<ProjectSettings>
  ): Project | undefined {
    const project = this.data.projects.find((p) => p.id === projectId);
    if (project) {
      project.settings = { ...project.settings, ...settings };
      project.updatedAt = new Date();
      this.save();
    }
    return project;
  }

  /**
   * Get tasks for a project by scanning specs directory
   * Implements caching with 3-second TTL to prevent excessive worktree scanning
   */
  getTasks(projectId: string): Task[] {
    // Check cache first
    const cached = this.tasksCache.get(projectId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
      return cached.tasks;
    }

    const project = this.getProject(projectId);
    if (!project) {
      return [];
    }

    const allTasks: Task[] = [];
    const specsBaseDir = getSpecsDir(project.autoBuildPath);

    // 1. Scan main project specs directory (source of truth for task existence)
    const mainSpecsDir = path.join(project.path, specsBaseDir);
    const mainSpecIds = new Set<string>();
    if (existsSync(mainSpecsDir)) {
      const mainTasks = this.loadTasksFromSpecsDir(mainSpecsDir, project.path, 'main', projectId, specsBaseDir);
      allTasks.push(...mainTasks);
      // Track which specs exist in main project
      mainTasks.forEach(t => mainSpecIds.add(t.specId));
    }

    // 2. Scan worktree specs directories
    // NOTE FOR MAINTAINERS: Worktree tasks are only included if the spec also exists in main.
    // This prevents deleted tasks from "coming back" when the worktree isn't cleaned up.
    const worktreesDir = getTaskWorktreeDir(project.path);
    if (existsSync(worktreesDir)) {
      try {
        const worktrees = readdirSync(worktreesDir, { withFileTypes: true });
        for (const worktree of worktrees) {
          if (!worktree.isDirectory()) continue;

          const worktreeSpecsDir = path.join(worktreesDir, worktree.name, specsBaseDir);
          if (existsSync(worktreeSpecsDir)) {
            const worktreeTasks = this.loadTasksFromSpecsDir(
              worktreeSpecsDir,
              path.join(worktreesDir, worktree.name),
              'worktree',
              projectId,
              specsBaseDir
            );
            // Only include worktree tasks if the spec exists in main project
            const validWorktreeTasks = worktreeTasks.filter(t => mainSpecIds.has(t.specId));
            allTasks.push(...validWorktreeTasks);
          }
        }
      } catch (error) {
        console.error('[ProjectStore] Error scanning worktrees:', error);
      }
    }

    // 3. Deduplicate tasks by ID. Main is the source of truth for terminal
    // tasks, but active worktrees carry the freshest running progress.
    const taskMap = new Map<string, Task>();
    for (const task of allTasks) {
      const existing = taskMap.get(task.id);
      if (!existing) {
        taskMap.set(task.id, task);
      } else {
        if (this.shouldReplaceTaskCandidate(existing, task)) {
          taskMap.set(task.id, this.mergeTaskDisplayFields(task, existing));
        } else {
          taskMap.set(existing.id, this.mergeTaskDisplayFields(existing, task));
        }
      }
    }

    const tasks = Array.from(taskMap.values());

    // Update cache
    this.tasksCache.set(projectId, { tasks, timestamp: now });

    return tasks;
  }

  private extractSpecDescription(content: string): string {
    const withoutTitle = content.replace(/^#\s+.*(?:\r?\n|$)/, '').trim();
    const isMetadataOnly = (text: string): boolean => {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return lines.length > 0 && lines.every((line) => /^-\s+\*\*[^*]+:\*\*/.test(line));
    };
    const introMatch = withoutTitle.match(/^([\s\S]*?)(?=\n#{1,6}\s|$)/);
    const intro = introMatch?.[1]?.trim() ?? '';
    if (intro && !intro.startsWith('#') && !isMetadataOnly(intro)) {
      return intro;
    }

    const preferredSection = content.match(
      /^##\s+(?:\d+[.)]\s*)?(?:Overview|Goal|Rationale|Summary|Revised Specification)\b[^\n]*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/im
    );
    if (preferredSection?.[1]?.trim()) {
      return preferredSection[1].trim();
    }

    const sectionMatches = content.matchAll(/^##\s+[^\n]*\n+([\s\S]*?)(?=\n#{1,6}\s|$)/gm);
    for (const match of sectionMatches) {
      const sectionBody = match[1]?.trim() ?? '';
      if (sectionBody && !isMetadataOnly(sectionBody)) {
        return sectionBody;
      }
    }

    return '';
  }

  private mergeTaskDisplayFields(selected: Task, sibling: Task): Task {
    const selectedDescription = selected.description?.trim() ?? '';
    const siblingDescription = sibling.description?.trim() ?? '';
    let merged = selected;

    if (!selectedDescription && siblingDescription) {
      merged = {
        ...merged,
        description: sibling.description,
      };
    }

    if (merged.subtasks.length === 0 && sibling.subtasks.length > 0) {
      merged = {
        ...merged,
        subtasks: sibling.subtasks,
      };
    }

    if (!merged.mergeCommit && sibling.mergeCommit) {
      merged = {
        ...merged,
        mergeCommit: sibling.mergeCommit,
      };
    }

    if (!merged.mergedAt && sibling.mergedAt) {
      merged = {
        ...merged,
        mergedAt: sibling.mergedAt,
      };
    }

    return merged;
  }

  private shouldReplaceTaskCandidate(existing: Task, candidate: Task): boolean {
    if (existing.location === candidate.location) {
      return this.isMoreCurrentTask(candidate, existing);
    }

    const existingIsWorktree = existing.location === 'worktree';
    const candidateIsWorktree = candidate.location === 'worktree';

    if (candidateIsWorktree) {
      return this.shouldPreferWorktreeTask(candidate, existing);
    }

    if (existingIsWorktree) {
      return !this.shouldPreferWorktreeTask(existing, candidate);
    }

    return this.isMoreCurrentTask(candidate, existing);
  }

  private shouldPreferWorktreeTask(worktreeTask: Task, mainTask: Task): boolean {
    if (mainTask.location !== 'main') {
      return this.isMoreCurrentTask(worktreeTask, mainTask);
    }

    if (this.isTerminalMainTask(mainTask)) {
      if (this.isActiveRecoveryWorktreeForTerminalTask(worktreeTask, mainTask)) {
        return true;
      }
      return false;
    }

    // Do not let a newer but empty worktree plan hide a populated main plan.
    // This can happen after a planning/coding crash writes runtime state in the
    // worktree before phases are synced, leaving the detail overview at 0 tasks.
    if (worktreeTask.subtasks.length === 0 && mainTask.subtasks.length > 0) {
      return false;
    }

    const worktreeCompleted = this.completedSubtaskCount(worktreeTask);
    const mainCompleted = this.completedSubtaskCount(mainTask);
    if (worktreeCompleted > mainCompleted) {
      return true;
    }

    const mainPassive = mainTask.status === 'backlog' || mainTask.status === 'queue';
    if (mainPassive && this.isActiveWorktreeTask(worktreeTask)) {
      return true;
    }

    const worktreePriority = TASK_STATUS_PRIORITY[worktreeTask.status] || 0;
    const mainPriority = TASK_STATUS_PRIORITY[mainTask.status] || 0;
    if (worktreePriority > mainPriority && worktreeTask.updatedAt.getTime() >= mainTask.updatedAt.getTime()) {
      return true;
    }

    return worktreeTask.updatedAt.getTime() > mainTask.updatedAt.getTime() && this.isActiveWorktreeTask(worktreeTask);
  }

  private isMoreCurrentTask(candidate: Task, existing: Task): boolean {
    const candidatePriority = TASK_STATUS_PRIORITY[candidate.status] || 0;
    const existingPriority = TASK_STATUS_PRIORITY[existing.status] || 0;
    if (candidatePriority !== existingPriority) {
      return candidatePriority > existingPriority;
    }

    const candidateCompleted = this.completedSubtaskCount(candidate);
    const existingCompleted = this.completedSubtaskCount(existing);
    if (candidateCompleted !== existingCompleted) {
      return candidateCompleted > existingCompleted;
    }

    return candidate.updatedAt.getTime() > existing.updatedAt.getTime();
  }

  private isTerminalMainTask(task: Task): boolean {
    return task.location === 'main' && (task.status === 'done' || task.status === 'pr_created');
  }

  private isActiveRecoveryWorktreeForTerminalTask(worktreeTask: Task, mainTask: Task): boolean {
    if (!this.isActiveWorktreeTask(worktreeTask)) return false;
    if (worktreeTask.updatedAt.getTime() < mainTask.updatedAt.getTime()) return false;
    if (!worktreeTask.specsPath) return false;

    const planPath = path.join(worktreeTask.specsPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
    try {
      const content = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, any>>(content);
      if (!plan) return false;

      if (plan.human_feedback_pending !== undefined) return true;

      if (
        typeof plan.recoveryNote === 'string'
        && (
          /^QA report failed\b/.test(plan.recoveryNote)
          || /^Base branch sync conflict\b/.test(plan.recoveryNote)
          || /^Recovered (stale terminal status|from stale done status)\b/.test(plan.recoveryNote)
          || /^Terminal failure blocked\b/.test(plan.recoveryNote)
          || /^Worktree setup failed\b/.test(plan.recoveryNote)
        )
      ) {
        return true;
      }

      const recoverySubtaskIds = new Set([
        'aperant-human-feedback-rework',
        'aperant-qa-report-failure',
        'aperant-base-sync-conflict',
      ]);
      const subtasks = Array.isArray(plan.phases)
        ? plan.phases.flatMap((phase: Record<string, any>) => Array.isArray(phase.subtasks) ? phase.subtasks : [])
        : [];
      return subtasks.some((subtask: Record<string, any>) => {
        return recoverySubtaskIds.has(String(subtask?.id ?? '')) && subtask?.status !== 'completed';
      });
    } catch {
      return false;
    }
  }

  private isActiveWorktreeTask(task: Task): boolean {
    return task.location === 'worktree' && (
      task.status === 'in_progress' ||
      task.status === 'ai_review' ||
      task.status === 'human_review' ||
      task.status === 'error'
    );
  }

  private completedSubtaskCount(task: Task): number {
    return task.subtasks.filter((subtask) => subtask.status === 'completed').length;
  }

  /**
   * Invalidate the tasks cache for a specific project
   * Call this when tasks are modified (created, deleted, status changed, etc.)
   */
  invalidateTasksCache(projectId: string): void {
    this.tasksCache.delete(projectId);
  }

  /**
   * Clear all tasks cache entries
   * Useful for global refresh scenarios
   */
  clearTasksCache(): void {
    this.tasksCache.clear();
  }

  /**
   * Load tasks from a specs directory (helper method for main project and worktrees)
   */
  private loadTasksFromSpecsDir(
    specsDir: string,
    basePath: string,
    location: 'main' | 'worktree',
    projectId: string,
    _specsBaseDir: string
  ): Task[] {
    const tasks: Task[] = [];
    let specDirs: Dirent[] = [];

    try {
      specDirs = readdirSync(specsDir, { withFileTypes: true });
    } catch (error) {
      console.error('[ProjectStore] Error reading specs directory:', error);
      return [];
    }

    for (const dir of specDirs) {
      if (!dir.isDirectory()) continue;
      if (dir.name === '.gitkeep') continue;

      try {
        const specPath = path.join(specsDir, dir.name);
        const planPath = path.join(specPath, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        const specFilePath = path.join(specPath, AUTO_BUILD_PATHS.SPEC_FILE);

        // Try to read implementation plan
        let plan: ImplementationPlan | null = null;
        let hasJsonError = false;
        let jsonErrorMessage = '';
        if (existsSync(planPath)) {
          try {
            const content = readFileSync(planPath, 'utf-8');
            const parsed = safeParseJson<ImplementationPlan>(content);
            if (parsed) {
              plan = parsed;
              this.clearResolvedBaseSyncConflictIfNeeded(
                plan as unknown as Record<string, unknown>,
                planPath,
                dir.name,
                location,
                basePath
              );
              this.clearResolvedRecoveryStateIfNeeded(
                plan as unknown as Record<string, unknown>,
                planPath,
                dir.name
              );
            } else {
              // safeParseJson returned null — JSON is unrepairable
              hasJsonError = true;
              jsonErrorMessage = 'Unrepairable JSON (auto-repair failed)';
              console.error(`[ProjectStore] Unrepairable JSON for spec ${dir.name} after auto-repair attempt`);
            }
          } catch (err) {
            // Read error (not parse — safeParseJson handles that)
            hasJsonError = true;
            jsonErrorMessage = err instanceof Error ? err.message : String(err);
            console.error(`[ProjectStore] Read error for spec ${dir.name}:`, jsonErrorMessage);
          }
        }

        let description = '';
        const requirementsPath = path.join(specPath, AUTO_BUILD_PATHS.REQUIREMENTS);
        // PRIORITY 1: Read original user task description from requirements.json
        if (existsSync(requirementsPath)) {
          try {
            const reqContent = readFileSync(requirementsPath, 'utf-8');
            const requirements = JSON.parse(reqContent);
            if (typeof requirements.task_description === 'string' && requirements.task_description.trim()) {
              // Use the full task description that the user entered
              description = requirements.task_description.trim();
            }
          } catch {
            // Ignore parse errors
          }
        }

        // PRIORITY 2: Fallback to plan description if user requirement text is missing
        if (!description && plan?.description) {
          description = plan.description;
        }

        // PRIORITY 3: Final fallback to spec.md summary content.
        if (!description && existsSync(specFilePath)) {
          try {
            const content = readFileSync(specFilePath, 'utf-8');
            description = this.extractSpecDescription(content);
          } catch {
            // Ignore read errors
          }
        }

        // Try to read task metadata
        const metadataPath = path.join(specPath, 'task_metadata.json');
        let metadata: TaskMetadata | undefined;
        if (existsSync(metadataPath)) {
          try {
            const content = readFileSync(metadataPath, 'utf-8');
            metadata = JSON.parse(content);
          } catch {
            // Ignore parse errors
          }
        }

        // Determine task status and review reason from plan
        // For JSON errors, store just the raw error - renderer will use i18n to format
        const finalDescription = hasJsonError
          ? `${JSON_ERROR_PREFIX}${jsonErrorMessage}`
          : description;
        if (!hasJsonError) {
          this.recoverMissingRuntimeStateForExecutablePlan(plan, planPath, specPath, dir.name);
          this.recoverUnstartedInProgressPlan(plan, planPath, specPath, dir.name, basePath);
        }
        // Tasks with JSON errors go to human_review with errors reason
        const { status: finalStatus, reviewReason: finalReviewReason } = hasJsonError
          ? { status: 'human_review' as TaskStatus, reviewReason: 'errors' as ReviewReason }
          : this.determineTaskStatusAndReason(plan);

        // Extract subtasks from plan (handle both 'subtasks' and 'chunks' naming)
        const subtasks = plan?.phases?.flatMap((phase) => {
          const items = phase.subtasks || (phase as { chunks?: PlanSubtask[] }).chunks || [];
          return items.map((subtask) => {
            const subtaskWithFallbacks = subtask as PlanSubtask & { name?: string };
            const title = subtask.title || subtask.description || subtaskWithFallbacks.name || subtask.id;
            const description = subtask.description || subtask.title || subtaskWithFallbacks.name || '';
            return {
              id: subtask.id,
              title,
              description,
              status: subtask.status,
              files: []
            };
          });
        }) || [];

        const doneGuardResult = this.correctDoneTaskWithIncompleteSubtasks(
          hasJsonError,
          finalStatus,
          finalReviewReason,
          plan,
          planPath,
          dir.name,
          basePath
        );

        // Auto-correct status to human_review if all subtasks are completed
        // This handles cases where task completed but app restarted before XState persisted the status
        // (e.g., QA_PASSED event emitted but not processed before shutdown)
        const { status: correctedStatus, reviewReason: correctedReviewReason } = this.correctStaleTaskStatus(
          subtasks,
          hasJsonError,
          doneGuardResult.status,
          doneGuardResult.reviewReason,
          plan,
          planPath,
          dir.name,
          basePath
        );

        // Extract staged status from plan (set when changes are merged with --no-commit)
        const planWithStaged = plan as unknown as { stagedInMainProject?: boolean; stagedAt?: string } | null;
        const stagedInMainProject = planWithStaged?.stagedInMainProject;
        const stagedAt = planWithStaged?.stagedAt;

        // Determine title - check if feature looks like a spec ID (e.g., "054-something-something")
        // For JSON error tasks, use directory name with marker for i18n suffix
        let title = hasJsonError ? `${dir.name}${JSON_ERROR_TITLE_SUFFIX}` : (plan?.feature || plan?.title || dir.name);
        const looksLikeSpecId = /^\d{3}-/.test(title) && !hasJsonError;
        if (looksLikeSpecId && existsSync(specFilePath)) {
          try {
            const specContent = readFileSync(specFilePath, 'utf-8');
            // Extract title from first # line, handling patterns like:
            // "# Quick Spec: Title" -> "Title"
            // "# Specification: Title" -> "Title"
            // "# Title" -> "Title"
            const titleMatch = specContent.match(/^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$/m);
            if (titleMatch?.[1]) {
              title = titleMatch[1].trim();
            }
          } catch {
            // Keep the original title on error
          }
        }

        const executionProgress = this.resolveExecutionProgressFromPlan(plan, planPath, dir.name);
        const mergeCommit = typeof plan?.mergeCommit === 'string' && plan.mergeCommit.trim()
          ? plan.mergeCommit
          : undefined;
        const mergedAt = typeof plan?.mergedAt === 'string' && plan.mergedAt.trim()
          ? plan.mergedAt
          : undefined;

        tasks.push({
          id: dir.name, // Use spec directory name as ID
          specId: dir.name,
          projectId,
          title,
          description: finalDescription,
          status: correctedStatus,
          subtasks,
          logs: [],
          metadata,
          ...(correctedReviewReason !== undefined && { reviewReason: correctedReviewReason }),
          ...(executionProgress && { executionProgress }),
          ...(mergeCommit && { mergeCommit }),
          ...(mergedAt && { mergedAt }),
          stagedInMainProject,
          stagedAt,
          location, // Add location metadata (main vs worktree)
          specsPath: specPath, // Add full path to specs directory
          createdAt: new Date(plan?.created_at || Date.now()),
          updatedAt: new Date(plan?.updated_at || Date.now())
        });
      } catch (error) {
        // Log error but continue processing other specs
        console.error(`[ProjectStore] Error loading spec ${dir.name}:`, error);
      }
    }

    return tasks;
  }

  private clearResolvedBaseSyncConflictIfNeeded(
    plan: Record<string, unknown>,
    planPath: string,
    taskName: string,
    location: 'main' | 'worktree',
    worktreePath: string
  ): void {
    if (location !== 'worktree' || plan.base_sync_conflict === undefined) return;
    if (this.worktreeHasUnmergedFiles(worktreePath)) return;

    let changed = false;
    delete plan.base_sync_conflict;
    changed = true;

    if (plan.recoveryNote === BASE_SYNC_RECOVERY_NOTE || (
      typeof plan.recoveryNote === 'string'
      && /^Base branch sync conflict\b/.test(plan.recoveryNote)
    )) {
      delete plan.recoveryNote;
    }

    if (this.completeBaseSyncRecoverySubtask(plan)) {
      changed = true;
    }

    try {
      rmSync(path.join(path.dirname(planPath), 'BASE_SYNC_CONFLICT.md'), { force: true });
    } catch {
      // Best effort cleanup for stale resolved conflict artifacts.
    }

    if (!changed) return;

    plan.updated_at = new Date().toISOString();
    try {
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[ProjectStore] Cleared resolved base-sync conflict metadata for ${taskName}.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to clear resolved base-sync metadata for ${taskName}:`, writeError);
    }
  }

  private worktreeHasUnmergedFiles(worktreePath: string): boolean {
    try {
      const output = execFileSync(getToolPath('git'), ['diff', '--name-only', '--diff-filter=U'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
      }).trim();
      return output.length > 0;
    } catch {
      // If Git cannot answer, preserve the recovery metadata instead of hiding a possible conflict.
      return true;
    }
  }

  private completeBaseSyncRecoverySubtask(plan: Record<string, unknown>): boolean {
    if (!Array.isArray(plan.phases)) return false;
    let changed = false;

    for (const phase of plan.phases as Array<{ subtasks?: Array<Record<string, unknown>> }>) {
      if (!Array.isArray(phase.subtasks)) continue;
      for (const subtask of phase.subtasks) {
        if (subtask.id !== BASE_SYNC_RECOVERY_SUBTASK_ID) continue;
        if (subtask.status === 'completed') continue;
        subtask.status = 'completed';
        subtask.completed_at = new Date().toISOString();
        subtask.completion_note = 'Auto-completed base sync recovery after Git reported no unmerged files on task load.';
        delete subtask.last_error;
        delete subtask.last_attempt_outcome;
        delete subtask.last_attempt_at;
        changed = true;
      }
    }

    return changed;
  }

  private clearResolvedRecoveryStateIfNeeded(
    plan: Record<string, unknown>,
    planPath: string,
    taskName: string
  ): void {
    const hasResolvedRecovery = hasResolvedRecoverySubtasks(plan);
    const changed = clearResolvedRecoveryState(plan);
    if (!hasResolvedRecovery && !changed) return;

    const artifactNames = [
      ...(plan.human_feedback_pending === undefined ? ['QA_FIX_REQUEST.md', 'QA_ESCALATION.md'] : []),
      ...(plan.base_sync_conflict === undefined ? ['BASE_SYNC_CONFLICT.md'] : []),
    ];
    let removedArtifact = false;
    for (const fileName of artifactNames) {
      const artifactPath = path.join(path.dirname(planPath), fileName);
      if (existsSync(artifactPath)) {
        removedArtifact = true;
      }
      try {
        rmSync(artifactPath, { force: true });
      } catch {
        // Best effort cleanup for stale resolved-recovery artifacts.
      }
    }

    if (!changed) {
      if (removedArtifact) {
        console.warn(`[ProjectStore] Removed stale resolved-recovery artifacts for ${taskName}.`);
      }
      return;
    }

    plan.updated_at = new Date().toISOString();
    try {
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[ProjectStore] Cleared stale resolved-recovery state for ${taskName}.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to clear resolved-recovery state for ${taskName}:`, writeError);
    }
  }

  /**
   * Correct stale task status when all subtasks are completed but status wasn't persisted.
   * Extracted from loadTasksFromSpecsDir to keep read/write separation clear.
   *
   * NOTE: This method intentionally writes to implementation_plan.json to persist the
   * correction and prevent repeated auto-corrections on every getTasks() call. The plan
   * object is NOT mutated unless the write succeeds, preserving memory/disk consistency.
   */
  private correctStaleTaskStatus(
    subtasks: { status: string }[],
    hasJsonError: boolean,
    finalStatus: TaskStatus,
    finalReviewReason: ReviewReason | undefined,
    plan: ImplementationPlan | null,
    planPath: string,
    taskName: string,
    basePath: string
  ): { status: TaskStatus; reviewReason: ReviewReason | undefined } {
    if (subtasks.length === 0 || hasJsonError) {
      return { status: finalStatus, reviewReason: finalReviewReason };
    }

    const completedCount = subtasks.filter(s => s.status === 'completed').length;
    const allCompleted = completedCount === subtasks.length;
    const qaReportApproved = this.hasApprovedQaReportVerdict(planPath);
    const qaApproved = qaReportApproved;
    const incompleteWorkflowStatus = finalStatus === 'backlog' || finalStatus === 'queue' || finalStatus === 'in_progress';

    if (allCompleted && qaApproved && finalStatus !== 'done' && finalStatus !== 'pr_created' && plan) {
      const mergeEvidence = findReachableTaskMergeEvidence({
        projectPath: basePath,
        specId: taskName,
        plan: plan as unknown as Record<string, unknown>,
      });

      if (mergeEvidence) {
        const correctedPlan = plan as unknown as Record<string, unknown>;
        correctedPlan.status = 'done';
        correctedPlan.planStatus = 'completed';
        correctedPlan.xstateState = 'done';
        correctedPlan.executionPhase = 'complete';
        correctedPlan.qa_signoff = isQASignoffApproved((correctedPlan as { qa_signoff?: Record<string, unknown> }).qa_signoff)
          ? correctedPlan.qa_signoff
          : {
            status: 'approved',
            issues_found: [],
            timestamp: new Date().toISOString(),
            source: 'project-store-merged-task-recovery:qa_report',
          };
        correctedPlan.mergeCommit = mergeEvidence.commitSha;
        correctedPlan.mergedAt = mergeEvidence.mergedAt;
        correctedPlan.lastEvent = {
          type: 'QA_PASSED',
          timestamp: new Date().toISOString(),
          source: `project-store-merged-task-recovery:${mergeEvidence.source}`,
        };
        correctedPlan.recoveryNote = `Recovered done status for ${taskName}: all subtasks are complete, QA is approved, and merge commit ${mergeEvidence.commitSha} is reachable.`;
        delete correctedPlan.reviewReason;
        clearResolvedRecoveryState(correctedPlan);
        correctedPlan.updated_at = new Date().toISOString();

        try {
          writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
          Object.assign(plan, correctedPlan);
          this.clearResolvedTaskMetadata(correctedPlan, planPath, taskName);
          console.warn(`[ProjectStore] Recovered merged done status for ${taskName} at ${mergeEvidence.commitSha}.`);
          return { status: 'done', reviewReason: undefined };
        } catch (writeError) {
          console.error(`[ProjectStore] Failed to persist merged done recovery for ${taskName}:`, writeError);
          return { status: finalStatus, reviewReason: finalReviewReason };
        }
      }
    }

    if (allCompleted && !qaApproved && incompleteWorkflowStatus && plan) {
      if (plan.updated_at) {
        const updatedAt = new Date(plan.updated_at).getTime();
        const ageMs = Date.now() - updatedAt;
        if (ageMs < 30_000) {
          return { status: finalStatus, reviewReason: finalReviewReason };
        }
      }

      const correctedPlan = plan as unknown as Record<string, unknown>;
      if (Array.isArray(correctedPlan.phases)) {
        for (const phase of correctedPlan.phases as Array<{ status?: string; subtasks?: Array<{ status?: string }> }>) {
          if (Array.isArray(phase.subtasks) && phase.subtasks.length > 0 && phase.subtasks.every((subtask) => subtask.status === 'completed')) {
            phase.status = 'completed';
          }
        }
      }
      correctedPlan.status = 'ai_review';
      correctedPlan.planStatus = 'review';
      correctedPlan.xstateState = 'qa_review';
      correctedPlan.executionPhase = 'qa_review';
      correctedPlan.lastEvent = {
        type: 'ALL_SUBTASKS_DONE',
        timestamp: new Date().toISOString(),
        source: 'project-store-completed-subtasks-recovery',
      };
      correctedPlan.recoveryNote = `Recovered completed subtask state for ${taskName}: all ${completedCount}/${subtasks.length} subtasks are complete but QA has not passed; routing to AI review.`;
      delete correctedPlan.reviewReason;
      delete correctedPlan.qa_signoff;
      delete correctedPlan.final_acceptance;
      correctedPlan.updated_at = new Date().toISOString();

      try {
        writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
        Object.assign(plan, correctedPlan);
        console.warn(`[ProjectStore] Routed completed task ${taskName} to AI review because QA has not passed.`);
        return { status: 'ai_review', reviewReason: undefined };
      } catch (writeError) {
        console.error(`[ProjectStore] Failed to persist AI review recovery for ${taskName}:`, writeError);
        return { status: finalStatus, reviewReason: finalReviewReason };
      }
    }

    // Only auto-correct if all subtasks are done, QA already approved, and status is in an incomplete coding state.
    // Preserve ai_review (QA in progress), error (needs investigation), human_review, done, pr_created.
    if (!allCompleted || !qaApproved || finalStatus === 'human_review' || finalStatus === 'done' || finalStatus === 'pr_created' || finalStatus === 'ai_review' || finalStatus === 'error') {
      return { status: finalStatus, reviewReason: finalReviewReason };
    }

    // Skip auto-correction if plan was recently updated (backend may still be writing)
    if (plan?.updated_at) {
      const updatedAt = new Date(plan.updated_at).getTime();
      const ageMs = Date.now() - updatedAt;
      if (ageMs < 30_000) {
        return { status: finalStatus, reviewReason: finalReviewReason };
      }
    }

    console.warn(`[ProjectStore] Auto-correcting task ${taskName}: all ${subtasks.length} subtasks completed but status was ${finalStatus}. Setting to human_review.`);

    if (plan) {
      // Clone before mutation — only apply to the original plan object if the write succeeds
      const correctedPlan = {
        ...plan,
        status: 'human_review' as const,
        planStatus: 'review',
        reviewReason: 'completed' as ReviewReason,
        updated_at: new Date().toISOString(),
        xstateState: 'human_review',
        executionPhase: 'complete'
      };
      try {
        // Atomic write to prevent 0-byte corruption on crash
        writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
        // Write succeeded — apply mutations to the in-memory plan so the rest of
        // loadTasksFromSpecsDir sees the corrected values (e.g., executionProgress)
        Object.assign(plan, correctedPlan);
        console.warn(`[ProjectStore] Persisted corrected status for task ${taskName}`);
      } catch (writeError) {
        // Write failed — leave the plan object unchanged and return the original status
        // so there's no memory/disk inconsistency
        console.error(`[ProjectStore] Failed to persist corrected status for task ${taskName}:`, writeError);
        return { status: finalStatus, reviewReason: finalReviewReason };
      }
    }

    return { status: 'human_review', reviewReason: 'completed' };
  }

  private correctDoneTaskWithIncompleteSubtasks(
    hasJsonError: boolean,
    finalStatus: TaskStatus,
    finalReviewReason: ReviewReason | undefined,
    plan: ImplementationPlan | null,
    planPath: string,
    taskName: string,
    basePath: string
  ): { status: TaskStatus; reviewReason: ReviewReason | undefined } {
    if (hasJsonError || !plan || !statusRequiresCompletedSubtasks(finalStatus, finalReviewReason)) {
      return { status: finalStatus, reviewReason: finalReviewReason };
    }

    const doneGuard = doneStatusHasIncompleteSubtasks(plan as unknown as Record<string, unknown>);
    const terminalStatus = finalStatus === 'done' || finalStatus === 'pr_created';
    const planMergeEvidence = planHasMergeCompletionEvidence(plan as unknown as Record<string, unknown>);
    const reachableMergeEvidence = terminalStatus
      ? findReachableTaskMergeEvidence({
        projectPath: basePath,
        specId: taskName,
        plan: plan as unknown as Record<string, unknown>,
      })
      : null;
    const recordedMergeUnreachable = terminalStatus && this.hasUnreachableMergeCommit(plan as unknown as Record<string, unknown>, basePath);
    const missingMergeEvidence = (
      terminalStatus
    ) && !planMergeEvidence && !reachableMergeEvidence;
    const unreachableMergeCommit = terminalStatus && recordedMergeUnreachable && !reachableMergeEvidence;
    const failedQaReport = this.hasFailedQaReportVerdict(planPath);
    const passingQaReport = this.hasApprovedQaReportVerdict(planPath);
    const qaPlanApproved = isQASignoffApproved((plan as unknown as { qa_signoff?: Record<string, unknown> }).qa_signoff);
    const completedHumanReview = finalStatus === 'human_review' && finalReviewReason === 'completed';
    const missingPassingQaReport = !passingQaReport && (terminalStatus || completedHumanReview || qaPlanApproved);

    if (!doneGuard.incomplete && !missingMergeEvidence && !unreachableMergeCommit && !failedQaReport && !missingPassingQaReport) {
      if (reachableMergeEvidence && (!planMergeEvidence || recordedMergeUnreachable)) {
        this.persistRecoveredMergeEvidence(
          plan as unknown as Record<string, unknown>,
          planPath,
          taskName,
          reachableMergeEvidence
        );
      }
      const recoveryNote = (plan as unknown as { recoveryNote?: unknown }).recoveryNote;
      if (typeof recoveryNote === 'string' && /^Blocked terminal (event|phase|status)\b/.test(recoveryNote)) {
        const correctedPlan = plan as unknown as Record<string, unknown>;
        delete correctedPlan.recoveryNote;
        correctedPlan.updated_at = new Date().toISOString();
        try {
          writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
          console.warn(`[ProjectStore] Cleared stale terminal recovery note for completed task ${taskName}.`);
        } catch (writeError) {
          console.error(`[ProjectStore] Failed to clear stale terminal recovery note for ${taskName}:`, writeError);
        }
      }
      if (
        finalStatus === 'done'
        || finalStatus === 'pr_created'
        || isQASignoffApproved((plan as unknown as { qa_signoff?: Record<string, unknown> }).qa_signoff)
      ) {
        this.clearResolvedTaskMetadata(plan as unknown as Record<string, unknown>, planPath, taskName);
      }
      return { status: finalStatus, reviewReason: finalReviewReason };
    }

    const { allCompleted } = checkSubtasksCompletion(plan as unknown as Record<string, unknown>);
    if (allCompleted && finalStatus === 'human_review' && finalReviewReason !== 'completed') {
      return { status: finalStatus, reviewReason: finalReviewReason };
    }
    const correctedPlan = plan as unknown as Record<string, unknown>;
    if (allCompleted && Array.isArray(correctedPlan.phases)) {
      for (const phase of correctedPlan.phases as Array<{ status?: string; subtasks?: Array<{ status?: string }> }>) {
        if (Array.isArray(phase.subtasks) && phase.subtasks.length > 0 && phase.subtasks.every((subtask) => subtask.status === 'completed')) {
          phase.status = 'completed';
        }
      }
      correctedPlan.status = 'ai_review';
      correctedPlan.planStatus = 'review';
      correctedPlan.xstateState = 'qa_review';
      correctedPlan.executionPhase = 'qa_review';
      correctedPlan.recoveryNote = failedQaReport
        ? `Recovered terminal status for ${taskName}: qa_report.md contains a failed verdict; rerunning QA and merge.`
        : unreachableMergeCommit
        ? `Recovered terminal status for ${taskName}: recorded merge commit is not reachable from the current checkout; rerunning QA and merge.`
        : missingMergeEvidence
        ? `Recovered terminal status for ${taskName}: merge evidence is missing; rerunning QA and merge.`
        : missingPassingQaReport
        ? `Recovered terminal status for ${taskName}: passing qa_report.md is missing; rerunning QA before accepting completion.`
        : `Recovered stale terminal status for ${taskName}: all subtasks are complete but QA or merge evidence is missing; rerunning QA.`;
      delete correctedPlan.reviewReason;
      delete correctedPlan.qa_signoff;
      delete correctedPlan.final_acceptance;
      if (missingMergeEvidence || unreachableMergeCommit || failedQaReport) {
        delete correctedPlan.mergeCommit;
        delete correctedPlan.mergedAt;
      }
      correctedPlan.updated_at = new Date().toISOString();

      try {
        writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
        Object.assign(plan, correctedPlan);
        console.warn(`[ProjectStore] Corrected unverifiable terminal status for ${taskName}; rerunning QA.`);
        return { status: 'ai_review', reviewReason: undefined };
      } catch (writeError) {
        console.error(`[ProjectStore] Failed to persist QA recovery status for ${taskName}:`, writeError);
        return { status: finalStatus, reviewReason: finalReviewReason };
      }
    }

    correctedPlan.status = 'in_progress';
    correctedPlan.planStatus = 'in_progress';
    correctedPlan.xstateState = 'coding';
    correctedPlan.executionPhase = 'coding';
    correctedPlan.recoveryNote = `Recovered from stale done status with ${doneGuard.completedCount}/${doneGuard.totalCount} completed subtasks at ${new Date().toISOString()}`;
    delete correctedPlan.reviewReason;
    delete correctedPlan.qa_signoff;
    delete correctedPlan.final_acceptance;
    correctedPlan.updated_at = new Date().toISOString();

    try {
      writeFileAtomicSync(planPath, JSON.stringify(correctedPlan, null, 2));
      Object.assign(plan, correctedPlan);
      console.warn(`[ProjectStore] Corrected stale terminal status for ${taskName}; continuing implementation.`);
      return { status: 'in_progress', reviewReason: undefined };
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to persist incomplete terminal correction for ${taskName}:`, writeError);
      return { status: finalStatus, reviewReason: finalReviewReason };
    }
  }

  private persistRecoveredMergeEvidence(
    plan: Record<string, unknown>,
    planPath: string,
    taskName: string,
    evidence: TaskMergeEvidence
  ): void {
    plan.mergeCommit = evidence.commitSha;
    plan.mergedAt = evidence.mergedAt;
    if (
      typeof plan.recoveryNote === 'string'
      && /^Recovered terminal status\b/.test(plan.recoveryNote)
    ) {
      delete plan.recoveryNote;
    }
    plan.updated_at = new Date().toISOString();
    try {
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[ProjectStore] Recovered merge evidence for ${taskName} from ${evidence.source}.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to persist recovered merge evidence for ${taskName}:`, writeError);
    }
  }

  private hasFailedQaReportVerdict(planPath: string): boolean {
    try {
      const qaReportPath = path.join(path.dirname(planPath), AUTO_BUILD_PATHS.QA_REPORT);
      const content = readFileSync(qaReportPath, 'utf-8');
      return getQaReportVerdictFromContent(content) === 'failed';
    } catch {
      return false;
    }
  }

  private hasApprovedQaReportVerdict(planPath: string): boolean {
    try {
      const qaReportPath = path.join(path.dirname(planPath), AUTO_BUILD_PATHS.QA_REPORT);
      const content = readFileSync(qaReportPath, 'utf-8');
      return getQaReportVerdictFromContent(content) === 'approved';
    } catch {
      return false;
    }
  }

  private hasUnreachableMergeCommit(plan: Record<string, unknown>, basePath: string): boolean {
    const mergeCommit = typeof plan.mergeCommit === 'string' ? plan.mergeCommit.trim() : '';
    if (!mergeCommit) return false;

    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: basePath,
        env: getIsolatedGitEnv(),
        stdio: 'ignore',
      });
      execFileSync('git', ['merge-base', '--is-ancestor', mergeCommit, 'HEAD'], {
        cwd: basePath,
        env: getIsolatedGitEnv(),
        stdio: 'ignore',
      });
      return false;
    } catch {
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
          cwd: basePath,
          env: getIsolatedGitEnv(),
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  private clearResolvedTaskMetadata(
    plan: Record<string, unknown>,
    planPath: string,
    taskName: string
  ): void {
    let changed = false;
    if (plan.human_feedback_pending !== undefined) {
      delete plan.human_feedback_pending;
      changed = true;
    }
    if (plan.base_sync_conflict !== undefined) {
      delete plan.base_sync_conflict;
      changed = true;
    }

    if (
      typeof plan.recoveryNote === 'string'
      && (
        /^Blocked terminal (event|phase|status)\b/.test(plan.recoveryNote)
        || /^QA report failed\b/.test(plan.recoveryNote)
        || /^Base branch sync conflict\b/.test(plan.recoveryNote)
        || /^Terminal failure blocked\b/.test(plan.recoveryNote)
        || /^Worktree setup failed\b/.test(plan.recoveryNote)
        || /^Reset to queue by backend stability reset\b/.test(plan.recoveryNote)
        || /^Recovered (stale terminal status|from stale done status)\b/.test(plan.recoveryNote)
      )
    ) {
      delete plan.recoveryNote;
      changed = true;
    }

    changed = clearCompletedSubtaskDiagnostics(plan) || changed;

    for (const fileName of ['QA_FIX_REQUEST.md', 'QA_ESCALATION.md', 'BASE_SYNC_CONFLICT.md']) {
      try {
        rmSync(path.join(path.dirname(planPath), fileName), { force: true });
      } catch {
        // Best effort cleanup for stale resolved-task artifacts.
      }
    }

    if (!changed) return;

    plan.updated_at = new Date().toISOString();
    try {
      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[ProjectStore] Cleared stale resolved-task metadata for ${taskName}.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to clear stale resolved-task metadata for ${taskName}:`, writeError);
    }
  }

  /**
   * Determine task status and review reason from the plan file.
   *
   * With the XState refactor, status and reviewReason are authoritative fields
   * written by the TaskStateManager. The renderer should not recompute status
   * from subtasks or QA files.
   */
  private determineTaskStatusAndReason(
    plan: ImplementationPlan | null
  ): { status: TaskStatus; reviewReason?: ReviewReason } {
    if (!plan?.status) {
      return { status: 'backlog' };
    }

    const statusMap: Record<string, TaskStatus> = {
      'pending': 'backlog',
      'planning': 'in_progress',
      'in_progress': 'in_progress',
      'coding': 'in_progress',
      'review': 'ai_review',
      'completed': 'done',
      'done': 'done',
      'human_review': 'human_review',
      'ai_review': 'ai_review',
      'pr_created': 'pr_created',
      'backlog': 'backlog',
      'error': 'error',
      'queue': 'queue',
      'queued': 'queue'
    };

    const storedStatus = statusMap[plan.status] || 'backlog';
    const reviewReason = storedStatus === 'human_review' ? plan.reviewReason : undefined;

    return { status: storedStatus, reviewReason };
  }

  private recoverMissingRuntimeStateForExecutablePlan(
    plan: ImplementationPlan | null,
    planPath: string,
    specPath: string,
    taskName: string,
  ): void {
    if (!plan) return;

    const mutablePlan = plan as unknown as Record<string, unknown>;
    if (
      mutablePlan.status !== undefined
      || mutablePlan.planStatus !== undefined
      || mutablePlan.xstateState !== undefined
      || mutablePlan.executionPhase !== undefined
    ) {
      return;
    }

    const completion = checkSubtasksCompletion(mutablePlan);
    if (completion.totalCount === 0 || completion.allCompleted) return;
    if (!this.hasCompletedPlanningLog(specPath)) return;

    if (!applyRuntimePhaseState(mutablePlan, 'idle')) return;

    const now = new Date().toISOString();
    mutablePlan.updated_at = now;
    mutablePlan.recoveryNote = 'Recovered executable plan with completed planning logs and missing runtime state; queued for coding.';
    mutablePlan.lastEvent = {
      eventId: `missing-runtime-recovery-${Date.now()}`,
      sequence: 0,
      type: 'PLANNING_COMPLETED',
      timestamp: now,
    };

    try {
      writeFileAtomicSync(planPath, JSON.stringify(mutablePlan, null, 2));
      console.warn(`[ProjectStore] Recovered missing runtime state for ${taskName}; queued for coding.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to persist missing runtime recovery for ${taskName}:`, writeError);
    }
  }

  private hasCompletedPlanningLog(specPath: string): boolean {
    const taskLogsPath = path.join(specPath, 'task_logs.json');
    if (!existsSync(taskLogsPath)) return false;

    try {
      const logs = safeParseJson<{
        phases?: {
          planning?: { status?: string };
        };
      }>(readFileSync(taskLogsPath, 'utf-8'));
      return logs?.phases?.planning?.status === 'completed';
    } catch {
      return false;
    }
  }

  private recoverUnstartedInProgressPlan(
    plan: ImplementationPlan | null,
    planPath: string,
    specPath: string,
    taskName: string,
    basePath: string,
  ): void {
    if (!plan) return;

    const mutablePlan = plan as unknown as Record<string, unknown>;
    if (mutablePlan.status !== 'in_progress') return;
    if (mutablePlan.xstateState !== 'coding' && mutablePlan.executionPhase !== 'coding') return;

    const completion = checkSubtasksCompletion(mutablePlan);
    if (completion.totalCount === 0 || completion.completedCount > 0) return;

    const lastEvent = mutablePlan.lastEvent as { type?: string } | undefined;
    if (lastEvent?.type === 'CODING_STARTED') return;
    if (!this.hasCompletedPlanningLog(specPath)) return;
    if (this.hasStartedCodingLog(specPath)) return;
    if (existsSync(path.join(getTaskWorktreeDir(basePath), taskName))) return;

    if (!applyRuntimePhaseState(mutablePlan, 'idle')) return;

    const now = new Date().toISOString();
    mutablePlan.updated_at = now;
    mutablePlan.recoveryNote = 'Recovered unstarted in-progress plan without coding logs or a task worktree; queued for coding.';
    mutablePlan.lastEvent = {
      eventId: `unstarted-coding-recovery-${Date.now()}`,
      sequence: 0,
      type: 'PLANNING_COMPLETED',
      timestamp: now,
    };

    try {
      writeFileAtomicSync(planPath, JSON.stringify(mutablePlan, null, 2));
      console.warn(`[ProjectStore] Recovered unstarted in-progress task ${taskName}; queued for coding.`);
    } catch (writeError) {
      console.error(`[ProjectStore] Failed to persist unstarted in-progress recovery for ${taskName}:`, writeError);
    }
  }

  private hasStartedCodingLog(specPath: string): boolean {
    const taskLogsPath = path.join(specPath, 'task_logs.json');
    if (!existsSync(taskLogsPath)) return false;

    try {
      const logs = safeParseJson<{
        phases?: {
          coding?: { status?: string; started_at?: string | null };
        };
      }>(readFileSync(taskLogsPath, 'utf-8'));
      const coding = logs?.phases?.coding;
      return Boolean(coding?.started_at) || (coding?.status !== undefined && coding.status !== 'pending');
    } catch {
      return false;
    }
  }

  /**
   * Infer execution progress from plan status for XState snapshot restoration.
   * Maps plan status values to ExecutionPhase so buildSnapshotFromTask can
   * correctly determine the XState state (planning vs coding vs qa_review, etc.).
   */
  private inferExecutionProgress(planStatus: string | undefined): { phase: ExecutionPhase; phaseProgress: number; overallProgress: number } | undefined {
    if (!planStatus) return undefined;

    // Map plan status to execution phase
    const phaseMap: Record<string, ExecutionPhase> = {
      'pending': 'idle',
      'backlog': 'idle',
      'queue': 'idle',
      'queued': 'idle',
      'planning': 'planning',
      'coding': 'coding',
      'in_progress': 'coding', // Default in_progress to coding
      'review': 'qa_review',
      'ai_review': 'qa_review',
      'qa_review': 'qa_review',
      'qa_fixing': 'qa_fixing',
      'human_review': 'complete',
      'completed': 'complete',
      'done': 'complete',
      'error': 'failed'
    };

    const phase = phaseMap[planStatus];
    if (!phase) return undefined;

    return {
      phase,
      phaseProgress: 50,
      overallProgress: 50
    };
  }

  /**
   * Infer execution progress from persisted XState state.
   * This is more precise than inferring from plan status since it uses the exact machine state.
   */
  private inferExecutionProgressFromXState(xstateState: string): { phase: ExecutionPhase; phaseProgress: number; overallProgress: number } | undefined {
    // Map XState state directly to execution phase
    const phaseMap: Record<string, ExecutionPhase> = {
      'backlog': 'idle',
      'planning': 'planning',
      'plan_review': 'planning',
      'coding': 'coding',
      'qa_review': 'qa_review',
      'qa_fixing': 'qa_fixing',
      'human_review': 'complete',
      'error': 'failed',
      'creating_pr': 'complete',
      'pr_created': 'complete',
      'done': 'complete'
    };

    const phase = phaseMap[xstateState];
    if (!phase) return undefined;

    return {
      phase,
      phaseProgress: phase === 'complete' ? 100 : 50,
      overallProgress: phase === 'complete' ? 100 : 50
    };
  }

  private resolveExecutionProgressFromPlan(
    plan: ImplementationPlan | null,
    planPath: string,
    taskName: string
  ): { phase: ExecutionPhase; phaseProgress: number; overallProgress: number } | undefined {
    if (!plan) return undefined;

    const mutablePlan = plan as unknown as Record<string, unknown>;
    let persistedPhase = mutablePlan.executionPhase as ExecutionPhase | undefined;
    const lastEvent = mutablePlan.lastEvent as { type?: string } | undefined;
    if (!persistedPhase && typeof lastEvent?.type === 'string') {
      const eventToPhase: Record<string, ExecutionPhase> = {
        PLANNING_STARTED: 'planning',
        CODING_STARTED: 'coding',
        ALL_SUBTASKS_DONE: 'qa_review',
        QA_STARTED: 'qa_review',
        QA_FAILED: 'qa_fixing',
        QA_FIXING_STARTED: 'qa_fixing',
        QA_FIXING_COMPLETE: 'coding',
        QA_PASSED: 'complete',
        PLANNING_FAILED: 'failed',
        CODING_FAILED: 'failed',
        QA_MAX_ITERATIONS: 'failed',
        QA_AGENT_ERROR: 'failed',
      };
      persistedPhase = eventToPhase[lastEvent.type];
      if (persistedPhase && applyRuntimePhaseState(mutablePlan, persistedPhase)) {
        mutablePlan.updated_at = new Date().toISOString();
        try {
          writeFileAtomicSync(planPath, JSON.stringify(mutablePlan, null, 2));
        } catch (error) {
          console.warn(`[ProjectStore] Failed to persist phase repair for ${taskName}:`, error);
        }
      }
    }

    const xstateState = mutablePlan.xstateState as string | undefined;
    const xstatePhase = xstateState ? XSTATE_TO_PHASE[xstateState] : undefined;
    if (
      xstateState
      && xstatePhase
      && XSTATE_ACTIVE_STATES.has(xstateState)
      && persistedPhase !== xstatePhase
    ) {
      persistedPhase = xstatePhase;
      if (applyRuntimePhaseState(mutablePlan, xstatePhase)) {
        mutablePlan.updated_at = new Date().toISOString();
        try {
          writeFileAtomicSync(planPath, JSON.stringify(mutablePlan, null, 2));
        } catch (error) {
          console.warn(`[ProjectStore] Failed to persist active phase repair for ${taskName}:`, error);
        }
      }
    }

    return persistedPhase
      ? { phase: persistedPhase, phaseProgress: persistedPhase === 'complete' ? 100 : 50, overallProgress: persistedPhase === 'complete' ? 100 : 50 }
      : xstateState
        ? this.inferExecutionProgressFromXState(xstateState)
        : this.inferExecutionProgress(plan.status);
  }

  /**
   * Archive tasks by writing archivedAt to their metadata
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to archive
   * @param version - Version they were archived in (optional)
   */
  archiveTasks(projectId: string, taskIds: string[], version?: string): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] archiveTasks: Project not found:', projectId);
      return false;
    }

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const archivedAt = new Date().toISOString();
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = findAllSpecPaths(project.path, specsBaseDir, taskId);

      // If spec directory doesn't exist anywhere, skip gracefully
      if (specPaths.length === 0) {
        continue;
      }

      // Archive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata = {};

          // Read existing metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            // File doesn't exist yet - start with empty metadata
            if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw readErr;
            }
          }

          // Add archive info
          metadata.archivedAt = archivedAt;
          if (version) {
            metadata.archivedInVersion = version;
          }

          writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
          console.error(`[ProjectStore] archiveTasks: Failed to archive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Update linked roadmap features for archived tasks
    this.updateRoadmapForArchivedTasks(project, taskIds);

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }

  /**
   * Update roadmap features linked to archived tasks
   */
  private updateRoadmapForArchivedTasks(project: Project, taskIds: string[]): void {
    const roadmapFile = path.join(project.path, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
    updateRoadmapFeatureOutcome(roadmapFile, taskIds, 'archived', '[ProjectStore]').catch((err) => {
      console.warn('[ProjectStore] Failed to update roadmap for archived tasks:', err);
    });
  }

  /**
   * Unarchive tasks by removing archivedAt from their metadata
   * @param projectId - Project ID
   * @param taskIds - IDs of tasks to unarchive
   */
  unarchiveTasks(projectId: string, taskIds: string[]): boolean {
    const project = this.getProject(projectId);
    if (!project) {
      console.error('[ProjectStore] unarchiveTasks: Project not found:', projectId);
      return false;
    }

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    let hasErrors = false;

    for (const taskId of taskIds) {
      // Find ALL locations where this task exists (main + worktrees)
      const specPaths = findAllSpecPaths(project.path, specsBaseDir, taskId);

      if (specPaths.length === 0) {
        console.warn(`[ProjectStore] unarchiveTasks: Spec directory not found for task ${taskId}`);
        continue;
      }

      // Unarchive in ALL locations
      for (const specPath of specPaths) {
        try {
          const metadataPath = path.join(specPath, 'task_metadata.json');
          let metadata: TaskMetadata;

          // Read metadata, handling missing file without TOCTOU race
          try {
            metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          } catch (readErr: unknown) {
            if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
              console.warn(`[ProjectStore] unarchiveTasks: Metadata file not found for task ${taskId} at ${specPath}`);
              continue;
            }
            throw readErr;
          }

          delete metadata.archivedAt;
          delete metadata.archivedInVersion;
          writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
        } catch (error) {
          console.error(`[ProjectStore] unarchiveTasks: Failed to unarchive task ${taskId} at ${specPath}:`, error);
          hasErrors = true;
          // Continue with other locations/tasks even if one fails
        }
      }
    }

    // Revert linked roadmap features from 'archived' back to 'in_progress'
    const roadmapFile = path.join(project.path, AUTO_BUILD_PATHS.ROADMAP_DIR, AUTO_BUILD_PATHS.ROADMAP_FILE);
    revertRoadmapFeatureOutcome(roadmapFile, taskIds, '[ProjectStore]').catch((err) => {
      console.warn('[ProjectStore] Failed to revert roadmap for unarchived tasks:', err);
    });

    // Invalidate cache since task metadata changed
    this.invalidateTasksCache(projectId);

    return !hasErrors;
  }
}

// Singleton instance
export const projectStore = new ProjectStore();
