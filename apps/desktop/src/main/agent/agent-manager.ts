import { EventEmitter } from 'events';
import path from 'path';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { AgentState } from './agent-state';
import { AgentEvents } from './agent-events';
import { AgentProcessManager } from './agent-process';
import { AgentQueueManager } from './agent-queue';
import { getClaudeProfileManager, initializeClaudeProfileManager } from '../claude-profile-manager';
import type { ClaudeProfileManager } from '../claude-profile-manager';
import { getOperationRegistry } from '../claude-profile/operation-registry';
import {
  AgentProcess,
  SpecCreationMetadata,
  TaskExecutionOptions,
  RoadmapConfig,
  ProcessType
} from './types';
import type { IdeationConfig, Project, Task } from '../../shared/types';
import { getPlanPathsForSpec, isMetadataOnlyQaFailureContent, readFailedQaEvidenceSync, recoverApprovedQASignoffForSpec, repairFalseCompletedSubtasksForSpec, resetStuckSubtasks, updatePlanAfterAppMerge } from '../ipc-handlers/task/plan-file-utils';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../shared/constants';
import { projectStore } from '../project-store';
import { resolveAuth, resolveAuthFromQueue } from '../ai/auth/resolver';
import { resolveModelId } from '../ai/config/phase-config';
import { detectProviderFromModel } from '../ai/providers/factory';
import { resolveModelEquivalent } from '../../shared/constants/models';
import type { BuiltinProvider } from '../../shared/types/provider-account';
import type { AgentExecutorConfig, SerializableSessionConfig, SerializedSecurityProfile } from '../ai/agent/types';
import { getSecurityProfile } from '../ai/security/security-profile';
import { createOrGetWorktree, syncWorktreeWithBaseBranch } from '../ai/worktree';
import { findTaskWorktree } from '../worktree-paths';
import { readSettingsFile } from '../settings-utils';
import type { ProviderAccount } from '../../shared/types/provider-account';
import { tryLoadPrompt } from '../ai/prompts/prompt-loader';
import { parseEnvFile } from '../ipc-handlers/utils';
import type { McpServerConfig } from '../ai/mcp/types';
import { MergeOrchestrator } from '../ai/merge/orchestrator';
import { MergeDecision } from '../ai/merge/types';
import { createMergeResolverFn } from '../ai/runners/merge-resolver';
import { getToolPath } from '../cli-tool-manager';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { cleanupWorktree } from '../utils/worktree-cleanup';
import { writeFileAtomicSync } from '../utils/atomic-file';
import { safeParseJson } from '../utils/json-repair';
import { findReachableTaskMergeEvidence, type TaskMergeEvidence } from '../task-merge-evidence';
import {
  checkSubtasksCompletion,
  clearStaleCompletionMetadataForActivePlan,
  clearResolvedRecoveryState,
  hasResolvedRecoverySubtasks,
} from '../task-plan-guards';
import { buildQaFixRequestContent, normalizeQaFailureEvidenceContent } from '../qa-feedback-utils';
import { taskStateManager } from '../task-state-manager';
import { cleanupStaleRateLimitPauseFile } from '../ai/orchestration/pause-handler';
import {
  BASE_SYNC_RECOVERY_NOTE,
  BASE_SYNC_RECOVERY_SUBTASK_ID,
  isBaseSyncConflictRecoveryCurrent,
} from './base-sync-recovery';
import {
  copyReviewArtifactsToMainSpec,
  findPassingQaReport,
} from './task-review-artifacts';
import {
  canAutoMergeCompletedHumanReviewPlans,
  canAutoMergeCompletedHumanReviewTask,
} from './human-review-merge-guard';

const DEFAULT_MAX_PARALLEL_TASKS = 3;
const MAX_CONCURRENT_PLANNING_RECOVERIES = 1;
const STALE_SPAWN_SETUP_MS = 2 * 60_000;
const STALE_WORKER_ACTIVITY_MS: Record<ProcessType, number> = {
  'spec-creation': 10 * 60_000,
  'task-execution': 20 * 60_000,
  'qa-process': 15 * 60_000,
};

export function isZombieProcessStat(stat: string): boolean {
  return stat.trim().startsWith('Z');
}

export function getProcessStatCommand(): string {
  return existsSync('/bin/ps') ? '/bin/ps' : 'ps';
}

const APERANT_WORKFLOW_GUARD = `

Aperant workflow guard:
- Do not run legacy local fleet/orchestrator commands such as "node scripts/orchestrate.mjs", "preflight", or "status" unless the active spec explicitly asks for that verification.
- Use the current Aperant spec, implementation_plan.json, and subtask status as the source of truth.
- Implement pending subtasks, run focused verification for the changed subtask, update the plan, and keep working until the plan is complete.
`;

function compactQaFallbackEvidence(content: string): string {
  const maxChars = 6_000;
  if (content.length <= maxChars) return content;
  return `[earlier content truncated]\n${content.slice(-maxChars)}`;
}

function loadProjectMcpEnv(projectPath: string, project?: { autoBuildPath?: string }): Record<string, string> {
  if (!project?.autoBuildPath) return {};
  try {
    const envPath = path.join(projectPath, project.autoBuildPath, '.env');
    if (!existsSync(envPath)) return {};
    return parseEnvFile(readFileSync(envPath, 'utf-8'));
  } catch {
    return {};
  }
}

function parseCustomMcpServers(value?: string): McpServerConfig[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as McpServerConfig[] : [];
  } catch {
    return [];
  }
}

function parseAgentMcpOverrides(vars: Record<string, string>): Record<string, { add?: string[]; remove?: string[] }> {
  const overrides: Record<string, { add?: string[]; remove?: string[] }> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (key.startsWith('AGENT_MCP_') && key.endsWith('_ADD')) {
      const agentId = key.replace('AGENT_MCP_', '').replace('_ADD', '');
      overrides[agentId] ??= {};
      overrides[agentId].add = value.split(',').map((server) => server.trim()).filter(Boolean);
    } else if (key.startsWith('AGENT_MCP_') && key.endsWith('_REMOVE')) {
      const agentId = key.replace('AGENT_MCP_', '').replace('_REMOVE', '');
      overrides[agentId] ??= {};
      overrides[agentId].remove = value.split(',').map((server) => server.trim()).filter(Boolean);
    }
  }
  return overrides;
}

function readPackageDependencies(packageJsonPath: string): Record<string, unknown> {
  try {
    if (!existsSync(packageJsonPath)) return {};
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return {};
  }
}

function detectMcpProjectCapabilities(projectPath: string): { is_electron: boolean; is_web_frontend: boolean } {
  const dependencyMaps = [readPackageDependencies(path.join(projectPath, 'package.json'))];
  for (const workspaceDir of ['apps', 'packages']) {
    const dir = path.join(projectPath, workspaceDir);
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        dependencyMaps.push(readPackageDependencies(path.join(dir, entry, 'package.json')));
      }
    } catch {
      // Optional workspace scan.
    }
  }
  const hasAnyDependency = (names: string[]) => dependencyMaps.some((deps) => names.some((name) => deps[name]));
  return {
    is_electron: hasAnyDependency(['electron', 'electron-builder', 'electron-vite']),
    is_web_frontend: hasAnyDependency(['next', 'react', 'vite', 'vue', 'svelte', '@sveltejs/kit', '@vitejs/plugin-react'])
      || existsSync(path.join(projectPath, 'app'))
      || existsSync(path.join(projectPath, 'pages')),
  };
}

function buildSessionMcpOptions(projectPath: string, project: { autoBuildPath?: string } | undefined, agentType: string) {
  const vars = loadProjectMcpEnv(projectPath, project);
  const customMcpServers = parseCustomMcpServers(vars.CUSTOM_MCP_SERVERS);
  const overrides = parseAgentMcpOverrides(vars);
  const agentOverride = overrides[agentType] ?? {};
  const memoryMcpUrl = vars.GRAPHITI_MCP_URL;
  const hasCustomMemoryServer = customMcpServers.some((server) => server.id === 'memory');
  const linearApiKey = vars.LINEAR_API_KEY;
  return {
    context7Enabled: vars.CONTEXT7_ENABLED?.toLowerCase() !== 'false',
    memoryEnabled: vars.GRAPHITI_ENABLED?.toLowerCase() === 'true' && (!!memoryMcpUrl || hasCustomMemoryServer),
    memoryMcpUrl,
    linearEnabled: vars.LINEAR_MCP_ENABLED?.toLowerCase() !== 'false',
    linearApiKey,
    electronMcpEnabled: vars.ELECTRON_MCP_ENABLED?.toLowerCase() === 'true',
    puppeteerMcpEnabled: vars.PUPPETEER_MCP_ENABLED?.toLowerCase() === 'true',
    projectCapabilities: detectMcpProjectCapabilities(projectPath),
    customMcpServers,
    customServerIds: customMcpServers.map((server) => String(server.id)).filter(Boolean),
    agentMcpAdd: agentOverride.add?.join(','),
    agentMcpRemove: agentOverride.remove?.join(','),
  };
}

/**
 * Main AgentManager - orchestrates agent process lifecycle
 * This is a slim facade that delegates to focused modules
 */
export class AgentManager extends EventEmitter {
  private state: AgentState;
  private events: AgentEvents;
  private processManager: AgentProcessManager;
  private queueManager: AgentQueueManager;
  private taskExecutionContext: Map<string, {
    projectPath: string;
    specId: string;
    options: TaskExecutionOptions;
    isSpecCreation?: boolean;
    taskDescription?: string;
    specDir?: string;
    metadata?: SpecCreationMetadata;
    baseBranch?: string;
    swapCount: number;
    projectId?: string;
    /** Generation counter to prevent stale cleanup after restart */
    generation: number;
  }> = new Map();
  private humanReviewMergeTimer: NodeJS.Timeout | null = null;
  private humanReviewMergeInProgress = false;
  private workflowRecoveryTimer: NodeJS.Timeout | null = null;
  private workflowRecoveryInProgress = false;

  constructor() {
    super();

    // Initialize modular components
    this.state = new AgentState();
    this.events = new AgentEvents();
    this.processManager = new AgentProcessManager(this.state, this.events, this);
    this.queueManager = new AgentQueueManager(this.state, this.events, this.processManager, this);

    // Listen for auto-swap restart events
    this.on('auto-swap-restart-task', (taskId: string, newProfileId: string) => {
      console.log('[AgentManager] Received auto-swap-restart-task event:', { taskId, newProfileId });
      const success = this.restartTask(taskId, newProfileId);
      console.log('[AgentManager] Task restart result:', success ? 'SUCCESS' : 'FAILED');
    });

    // Listen for task completion to clean up context (prevent memory leak)
    this.on('exit', (taskId: string, code: number | null, processType?: string, _projectId?: string) => {
      // Clean up context when:
      // 1. Task completed successfully (code === 0), or
      // 2. Task failed and won't be restarted (handled by auto-swap logic)

      // Capture generation at exit time to prevent race conditions with restarts
      const contextAtExit = this.taskExecutionContext.get(taskId);
      const generationAtExit = contextAtExit?.generation;

      // Note: Auto-swap restart happens BEFORE this exit event is processed,
      // so we need a small delay to allow restart to preserve context
      setTimeout(() => {
        const context = this.taskExecutionContext.get(taskId);
        if (!context) return; // Already cleaned up or restarted

        // Check if the context's generation matches - if not, a restart incremented it
        // and this cleanup is for a stale exit event that shouldn't affect the new task
        if (generationAtExit !== undefined && context.generation !== generationAtExit) {
          return; // Stale exit event - task was restarted, don't clean up new context
        }

        // If task completed successfully, always clean up
        if (code === 0) {
          this.taskExecutionContext.delete(taskId);
          // Unregister from OperationRegistry
          getOperationRegistry().unregisterOperation(taskId);
          return;
        }

        // If task failed and hit max retries, clean up
        if (context.swapCount >= 2) {
          this.taskExecutionContext.delete(taskId);
          // Unregister from OperationRegistry
          getOperationRegistry().unregisterOperation(taskId);
        }
        // Otherwise keep context for potential restart
      }, 1000); // Delay to allow restart logic to run first

      if (processType === 'task-execution' || processType === 'qa-process' || processType === 'spec-creation') {
        setTimeout(() => {
          this.runWorkflowRecoveryPass(`worker-exit:${processType}`).catch((error) => {
            console.warn('[AgentManager] Worker-exit workflow recovery failed:', error);
          });
        }, 1500);
      }
    });
  }

  /**
   * Configure paths for Python and auto-claude source
   */
  configure(pythonPath?: string, autoBuildSourcePath?: string): void {
    this.processManager.configure(pythonPath, autoBuildSourcePath);
  }

  /**
   * Check if any provider account is configured (API key or OAuth).
   * Used to bypass the legacy hasValidAuth() check for non-Anthropic providers.
   */
  private hasAnyProviderAccount(): boolean {
    const settings = readSettingsFile();
    const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined) ?? [];
    return accounts.length > 0;
  }

  /**
   * Resolve auth using the provider accounts priority queue.
   * Falls back to legacy Claude profile if no provider accounts exist.
   */
  private async resolveAuthFromProviderQueue(
    requestedModel: string,
    preferredProvider?: string | null,
  ): Promise<{
    auth: { apiKey?: string; baseURL?: string; oauthTokenFilePath?: string } | null;
    provider: string;
    modelId: string;
    configDir?: string;
  }> {
    // Read provider accounts and priority order from settings
    const settings = readSettingsFile();
    const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined) ?? [];
    const priorityOrder = (settings?.globalPriorityOrder as string[] | undefined) ?? [];

    if (accounts.length > 0 && priorityOrder.length > 0) {
      // Sort accounts by priority order
      const orderedQueue = priorityOrder
        .map(id => accounts.find(a => a.id === id))
        .filter((a): a is ProviderAccount => a != null);

      // Add any accounts not in the priority order at the end
      for (const account of accounts) {
        if (!priorityOrder.includes(account.id)) {
          orderedQueue.push(account);
        }
      }

      // If a preferred provider is specified, reorder queue to try that provider first
      if (preferredProvider) {
        const preferred: ProviderAccount[] = [];
        const rest: ProviderAccount[] = [];
        for (const acct of orderedQueue) {
          if (acct.provider === preferredProvider) {
            preferred.push(acct);
          } else {
            rest.push(acct);
          }
        }
        orderedQueue.splice(0, orderedQueue.length, ...preferred, ...rest);
      }

      const resolved = await resolveAuthFromQueue(requestedModel, orderedQueue);
      if (resolved) {
        console.warn(`[AgentManager] Resolved auth from provider queue: account=${resolved.accountId} provider=${resolved.resolvedProvider} model=${resolved.resolvedModelId}`);
        return {
          auth: resolved,
          provider: resolved.resolvedProvider,
          modelId: resolved.resolvedModelId,
          configDir: undefined, // Queue-based auth handles its own token refresh
        };
      }
      console.warn('[AgentManager] No available account in provider queue, falling back to legacy profile');
    }

    // Fallback: legacy Claude profile system
    const profileManager = getClaudeProfileManager();
    const activeProfile = profileManager?.getActiveProfile();
    const configDir = activeProfile?.configDir;
    const auth = await resolveAuth({ provider: 'anthropic', configDir });
    const provider = detectProviderFromModel(requestedModel) ?? 'anthropic';
    return { auth, provider, modelId: requestedModel, configDir };
  }

  /**
   * Run startup recovery scan to detect and reset stuck subtasks on app launch
   * Scans all projects for implementation_plan.json files and resets any stuck subtasks
   */
  async runStartupRecoveryScan(): Promise<void> {
    console.log('[AgentManager] Running startup recovery scan for stuck subtasks...');

    try {
      // Get all projects from the store
      const projects = projectStore.getProjects();

      if (projects.length === 0) {
        console.log('[AgentManager] No projects found - skipping startup recovery scan');
        this.startWorkflowRecoveryWatchdog();
        return;
      }

      let totalScanned = 0;
      let totalReset = 0;
      let totalFalseCompletedReset = 0;
      let totalStalePausesRemoved = 0;

      // Scan each project for stuck subtasks
      for (const project of projects) {
        if (!project.autoBuildPath) {
          continue; // Skip projects that haven't been initialized yet
        }

        const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));

        // Check if specs directory exists
        if (!existsSync(specsDir)) {
          continue;
        }

        // Read all spec directories
        try {
          const specDirs = readdirSync(specsDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

          // Process each spec directory
          for (const specDirName of specDirs) {
            const planPath = path.join(specsDir, specDirName, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

            // Check if implementation_plan.json exists
            if (!existsSync(planPath)) {
              continue;
            }

            totalScanned++;

            if (cleanupStaleRateLimitPauseFile(path.dirname(planPath))) {
              totalStalePausesRemoved++;
              console.log(`[AgentManager] Startup recovery: Removed stale rate-limit pause in ${specDirName}`);
            }

            // Reset stuck subtasks (pass project.id to invalidate tasks cache)
            const { success, resetCount } = await resetStuckSubtasks(planPath, project.id);

            if (success && resetCount > 0) {
              totalReset += resetCount;
              console.log(`[AgentManager] Startup recovery: Reset ${resetCount} stuck subtask(s) in ${specDirName}`);
            }

            const falseCompletionResetCount = await repairFalseCompletedSubtasksForSpec(project, specDirName);
            if (falseCompletionResetCount > 0) {
              totalFalseCompletedReset += falseCompletionResetCount;
              console.log(`[AgentManager] Startup recovery: Reset ${falseCompletionResetCount} false-completed subtask(s) in ${specDirName}`);
            }
          }
        } catch (err) {
          console.warn(`[AgentManager] Failed to scan specs directory for project ${project.name}:`, err);
        }
      }

      if (totalReset > 0 || totalFalseCompletedReset > 0) {
        console.log(`[AgentManager] Startup recovery complete: Reset ${totalReset} stuck subtask(s) and ${totalFalseCompletedReset} false-completed subtask(s) across ${totalScanned} task(s)`);
      } else if (totalStalePausesRemoved > 0) {
        console.log(`[AgentManager] Startup recovery complete: Removed ${totalStalePausesRemoved} stale rate-limit pause file(s) across ${totalScanned} task(s)`);
      } else {
        console.log(`[AgentManager] Startup recovery complete: No stuck subtasks found (scanned ${totalScanned} task(s))`);
      }

      this.invalidateRecoveryTaskCaches(projects);
      await this.resumeOrphanedWorkflowTasks(projects, 'startup-recovery');
      this.scheduleHumanReviewMerge('startup-recovery', 1000);
    } catch (err) {
      console.error('[AgentManager] Startup recovery scan failed:', err);
    } finally {
      this.startWorkflowRecoveryWatchdog();
    }
  }

  private startWorkflowRecoveryWatchdog(): void {
    if (this.workflowRecoveryTimer) return;
    this.workflowRecoveryTimer = setInterval(() => {
      this.runWorkflowRecoveryPass('watchdog').catch((error) => {
        console.warn('[AgentManager] Workflow recovery watchdog failed:', error);
      });
    }, 30_000);
  }

  async runWorkflowRecoveryPass(reason = 'manual'): Promise<void> {
    if (this.workflowRecoveryInProgress) return;
    this.workflowRecoveryInProgress = true;
    try {
      const projects = projectStore.getProjects();
      this.invalidateRecoveryTaskCaches(projects);
      this.stopStaleRunningWorkers(projects, reason);
      this.invalidateRecoveryTaskCaches(projects);
      await this.resumeOrphanedWorkflowTasks(projects, reason);
      this.scheduleHumanReviewMerge(reason, 1000);
    } finally {
      this.workflowRecoveryInProgress = false;
    }
  }

  private invalidateRecoveryTaskCaches(projects: Project[]): void {
    for (const project of projects) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private recoverApprovedQaForTask(project: Project, task: Task, source: string): boolean {
    if (!recoverApprovedQASignoffForSpec(project, task.specId, source)) return false;

    taskStateManager.handleUiEvent(task.id, {
      type: 'QA_PASSED',
      iteration: 0,
      testsRun: {},
    }, task, project);
    this.scheduleHumanReviewMerge(source, 1500);
    console.warn(`[AgentManager] Workflow recovery accepted passed QA report for ${task.specId}`);
    return true;
  }

  private stopStaleRunningWorkers(projects: Project[], reason: string): void {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const now = Date.now();

    for (const [taskId, processInfo] of Array.from(this.state.getAllProcesses())) {
      if (processInfo.projectId && !projectsById.has(processInfo.projectId)) continue;

      if (!this.isTrackedProcessLive(processInfo, now)) {
        this.clearTrackedProcess(taskId, processInfo, projectsById, `${reason} recovery clearing exited worker handle`);
        continue;
      }

      const processType = processInfo.processType ?? 'task-execution';
      const thresholdMs = STALE_WORKER_ACTIVITY_MS[processType];
      const lastActivityAt = processInfo.lastActivityAt ?? processInfo.startedAt;
      const inactiveMs = now - lastActivityAt.getTime();
      if (inactiveMs < thresholdMs) continue;

      const project = processInfo.projectId ? projectsById.get(processInfo.projectId) : undefined;
      const task = project ? projectStore.getTasks(project.id).find((candidate) => candidate.id === taskId) : undefined;
      const label = task?.specId ?? taskId;
      console.warn(
        `[AgentManager] ${reason} recovery stopping stale ${processType} worker for ${label} ` +
        `after ${Math.round(inactiveMs / 1000)}s without activity`
      );
      this.emit('error', taskId, `Worker had no activity for ${Math.round(inactiveMs / 60_000)} minutes; restarting recovery.`, processInfo.projectId);
      this.killTask(taskId);
    }
  }

  private clearTrackedProcess(
    taskId: string,
    processInfo: AgentProcess,
    projectsById: Map<string, Project>,
    reason: string,
  ): void {
    const project = processInfo.projectId ? projectsById.get(processInfo.projectId) : undefined;
    const task = project ? projectStore.getTasks(project.id).find((candidate) => candidate.id === taskId) : undefined;
    const label = task?.specId ?? taskId;
    console.warn(`[AgentManager] ${reason} for ${label}`);
    this.killTask(taskId);
  }

  private isTrackedProcessLive(processInfo: AgentProcess, now = Date.now()): boolean {
    const handles = [processInfo.process, processInfo.worker].filter(Boolean);
    if (handles.length === 0) {
      return now - processInfo.startedAt.getTime() < STALE_SPAWN_SETUP_MS;
    }
    return handles.some((handle) => this.isProcessHandleLive(handle));
  }

  private isProcessHandleLive(handle: unknown): boolean {
    const candidate = handle as {
      exitCode?: number | null;
      signalCode?: NodeJS.Signals | null;
      threadId?: number;
      pid?: number;
      killed?: boolean;
      connected?: boolean;
    };

    if (
      (candidate.exitCode !== null && candidate.exitCode !== undefined)
      || (candidate.signalCode !== null && candidate.signalCode !== undefined)
    ) {
      return false;
    }

    if (typeof candidate.threadId === 'number') {
      return candidate.threadId >= 0;
    }

    if (typeof candidate.pid === 'number' && candidate.pid > 0) {
      return this.isPidAlive(candidate.pid);
    }

    if (candidate.killed === true && candidate.connected === false) {
      return false;
    }

    if (candidate.connected === true) {
      return true;
    }

    return false;
  }

  private isPidAlive(pid: number): boolean {
    try {
      if (process.platform !== 'win32') {
        try {
          const stat = execFileSync(getProcessStatCommand(), ['-o', 'stat=', '-p', String(pid)], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
          if (stat && isZombieProcessStat(stat)) return false;
        } catch {
          // Fall back to kill(0); ps can fail for races or unsupported flags.
        }
      }
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async resumeOrphanedWorkflowTasks(projects: Project[], reason = 'workflow-recovery'): Promise<void> {
    let totalStarted = 0;

    for (const project of projects) {
      try {
        const maxParallelTasks = this.getMaxParallelTasks(project);
        let tasks = projectStore.getTasks(project.id)
          .filter((task) => !task.metadata?.archivedAt);

        for (const task of tasks) {
          if (!this.isRecoverableTaskStatus(task.status)) continue;
          const conflictFiles = this.getTaskWorktreeConflictFiles(project, task);
          if (conflictFiles.length === 0) {
            this.clearResolvedBaseSyncConflictForTask(project, task);
            continue;
          }
          this.persistBaseSyncConflictForCoding(project, task, conflictFiles, 'worktree_has_unmerged_conflicts');
        }
        tasks = projectStore.getTasks(project.id)
          .filter((task) => !task.metadata?.archivedAt);

        const activeTasks = tasks
          .filter((task) =>
            task.status === 'in_progress'
            || task.status === 'ai_review'
            || this.shouldResumePlanningFailure(project, task)
            || this.shouldResumeIncompleteTerminalTask(project, task)
            || this.shouldRetryTerminalAgentError(project, task)
          )
          .sort((a, b) => {
            const priorityDiff = this.getWorkflowRecoveryPriority(project, a) - this.getWorkflowRecoveryPriority(project, b);
            if (priorityDiff !== 0) return priorityDiff;
            return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          });

        for (const task of activeTasks) {
          if (task.status === 'ai_review' && this.recoverApprovedQaForTask(project, task, `${reason}-qa-report`)) continue;
          if (this.countRunningProjectTasks(project) >= maxParallelTasks) {
            this.deferInactiveInProgressTaskForCapacity(project, task, reason);
            continue;
          }
          if (this.isRunning(task.id)) continue;
          if (this.shouldDeferPlanningRecovery(project, task)) continue;
          if (await this.resumePersistedWorkflowTask(project, task)) totalStarted++;
        }

        const queuedTasks = projectStore.getTasks(project.id)
          .filter((task) => task.status === 'queue' && !task.metadata?.archivedAt)
          .sort((a, b) => this.compareQueuedWorkflowTasks(project, a, b));

        for (const task of queuedTasks) {
          if (this.countRunningProjectTasks(project) >= maxParallelTasks) break;
          if (this.isRunning(task.id)) continue;
          if (this.shouldDeferPlanningRecovery(project, task)) continue;
          if (await this.resumePersistedWorkflowTask(project, task)) totalStarted++;
        }
      } catch (error) {
        console.warn(`[AgentManager] Workflow recovery could not scan project ${project.name ?? project.id}:`, error);
      }
    }

    if (totalStarted > 0) {
      console.warn(`[AgentManager] Startup recovery resumed ${totalStarted} task worker(s)`);
    }
  }

  private isRecoverableTaskStatus(status: Task['status']): boolean {
    return status === 'in_progress' || status === 'ai_review' || status === 'human_review' || status === 'error';
  }

  private getWorkflowRecoveryPriority(project: Project, task: Task): number {
    if (task.status === 'ai_review') return 0;
    if (this.hasPendingQaReportRecovery(project, task)) return 1;
    if (this.hasPendingHumanFeedbackRework(project, task)) return 1;

    const completedSubtasks = task.subtasks.filter((subtask) => subtask.status === 'completed').length;
    if (completedSubtasks > 0) return 2;

    if (task.status === 'human_review' || task.status === 'error') return 3;
    return 4;
  }

  private compareQueuedWorkflowTasks(project: Project, a: Task, b: Task): number {
    const priorityDiff = this.getQueuedWorkflowPriority(project, a) - this.getQueuedWorkflowPriority(project, b);
    if (priorityDiff !== 0) return priorityDiff;

    const timeDiff = this.getTaskQueueTimestamp(a) - this.getTaskQueueTimestamp(b);
    if (timeDiff !== 0) return timeDiff;

    return a.specId.localeCompare(b.specId, undefined, { numeric: true, sensitivity: 'base' });
  }

  private getQueuedWorkflowPriority(project: Project, task: Task): number {
    if (!this.taskHasPlanSubtasks(project, task)) return 2;
    return this.getCompletedPlanSubtaskCount(project, task) > 0 ? 0 : 1;
  }

  private getCompletedPlanSubtaskCount(project: Project, task: Task): number {
    if (task.subtasks.length > 0) {
      return task.subtasks.filter((subtask) => subtask.status === 'completed').length;
    }

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        return checkSubtasksCompletion(plan).completedCount;
      } catch {
        // Ignore unreadable plans; the task will keep its normal queue ordering.
      }
    }

    return 0;
  }

  private getTaskQueueTimestamp(task: Task): number {
    const createdAt = this.getSafeTimestamp(task.createdAt);
    if (createdAt !== Number.POSITIVE_INFINITY) return createdAt;
    return this.getSafeTimestamp(task.updatedAt);
  }

  private getSafeTimestamp(value: unknown): number {
    const timestamp = value instanceof Date
      ? value.getTime()
      : new Date(value as string | number).getTime();
    return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
  }

  private hasPendingHumanFeedbackRework(project: Project, task: Task): boolean {
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan?.human_feedback_pending) continue;
        const subtasks = (Array.isArray(plan.phases) ? plan.phases : [])
          .flatMap((phase: Record<string, any>) => Array.isArray(phase.subtasks) ? phase.subtasks : []);
        const rework = subtasks.find((subtask: Record<string, any>) => subtask?.id === 'aperant-human-feedback-rework');
        return !rework || rework.status !== 'completed';
      } catch {
        // Ignore unreadable plans and continue checking alternate plan paths.
      }
    }
    return false;
  }

  private getTaskWorktreeConflictFiles(project: Project, task: Task): string[] {
    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (!worktreePath || !existsSync(worktreePath)) return [];
    try {
      const output = execFileSync(getToolPath('git'), ['diff', '--name-only', '--diff-filter=U'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
      }).trim();
      return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private clearResolvedBaseSyncConflictForTask(project: Project, task: Task): void {
    let persisted = false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;

        let changed = false;
        if (plan.base_sync_conflict !== undefined) {
          delete plan.base_sync_conflict;
          changed = true;
        }
        if (plan.recoveryNote === BASE_SYNC_RECOVERY_NOTE || (
          typeof plan.recoveryNote === 'string'
          && /^Base branch sync conflict\b/.test(plan.recoveryNote)
        )) {
          delete plan.recoveryNote;
          changed = true;
        }

        if (Array.isArray(plan.phases)) {
          for (const phase of plan.phases as Array<{ subtasks?: Array<Record<string, any>> }>) {
            if (!Array.isArray(phase.subtasks)) continue;
            for (const subtask of phase.subtasks) {
              if (subtask.id !== BASE_SYNC_RECOVERY_SUBTASK_ID || subtask.status === 'completed') continue;
              subtask.status = 'completed';
              subtask.completed_at = new Date().toISOString();
              subtask.completion_note = 'Auto-completed base sync recovery after Git reported no unmerged files during workflow recovery.';
              delete subtask.last_error;
              delete subtask.last_attempt_outcome;
              delete subtask.last_attempt_at;
              changed = true;
            }
          }
        }

        try {
          rmSync(path.join(path.dirname(planPath), 'BASE_SYNC_CONFLICT.md'), { force: true });
        } catch {
          // Best effort cleanup for stale resolved conflict artifacts.
        }

        if (!changed) continue;
        plan.updated_at = new Date().toISOString();
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to clear resolved base sync conflict for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private async resumePersistedWorkflowTask(project: Project, task: Task): Promise<boolean> {
    let allSubtasksComplete = this.areAllPlanSubtasksComplete(project, task)
      || task.subtasks.length > 0 && task.subtasks.every((subtask) => subtask.status === 'completed');
    const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const specDir = path.join(project.path, specsBaseDir, task.specId);
    const specFilePath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
    const hasSpec = existsSync(specFilePath);
    const hasPlanSubtasks = this.taskHasPlanSubtasks(project, task);

    try {
      if (this.clearMetadataOnlyQaRecovery(project, task)) {
        allSubtasksComplete = this.areAllPlanSubtasksComplete(project, task)
          || task.subtasks.length > 0 && task.subtasks.every((subtask) => subtask.status === 'completed');
        if (allSubtasksComplete) {
          this.persistRuntimeState(project, task, 'ai_review', 'review', 'qa_review', 'qa_review');
          console.warn(`[AgentManager] Startup recovery rerouting metadata-only QA failure to QA for ${task.specId}`);
          await this.startQAProcess(task.id, project.path, task.specId, project.id);
          return true;
        }
      }

      if (task.status === 'in_progress' && this.hasPendingQaReportRecovery(project, task)) {
        const failure = this.findFailedQaReport(project, task);
        if (failure) {
          this.persistQaReportFailureForCoding(project, task, failure.content, failure.reportPath);
          console.warn(`[AgentManager] Startup recovery refreshed failed QA evidence for ${task.specId}`);
        }
      }

      if ((task.status === 'ai_review' || this.shouldRetryTerminalAgentError(project, task)) && allSubtasksComplete) {
        if (recoverApprovedQASignoffForSpec(project, task.specId, 'workflow-recovery-qa-report')) {
          taskStateManager.handleUiEvent(task.id, {
            type: 'QA_PASSED',
            iteration: 0,
            testsRun: {},
          }, task, project);
          this.scheduleHumanReviewMerge('workflow-recovery-qa-report', 1500);
          console.warn(`[AgentManager] Startup recovery accepted passed QA report for ${task.specId}`);
          return true;
        }

        if (this.hasPendingQaReportRecovery(project, task) || this.findFailedQaReport(project, task)) {
          const resumedFromFailedQaReport = await this.resumeCodingForFailedQaReport(project, task);
          if (resumedFromFailedQaReport) {
            console.warn(`[AgentManager] Startup recovery routed failed QA report back to coding for ${task.specId}`);
            return true;
          }
        }
      }

      if (task.status === 'in_progress' && allSubtasksComplete) {
        if (recoverApprovedQASignoffForSpec(project, task.specId, 'workflow-recovery-qa-report')) {
          taskStateManager.handleUiEvent(task.id, {
            type: 'QA_PASSED',
            iteration: 0,
            testsRun: {},
          }, task, project);
          this.scheduleHumanReviewMerge('workflow-recovery-qa-report', 1500);
          console.warn(`[AgentManager] Startup recovery accepted passed QA report for completed in-progress task ${task.specId}`);
          return true;
        }

        if (this.findFailedQaReport(project, task)) {
          const resumedFromFailedQaReport = await this.resumeCodingForFailedQaReport(project, task);
          if (resumedFromFailedQaReport) {
            console.warn(`[AgentManager] Startup recovery routed completed in-progress failed QA report back to coding for ${task.specId}`);
            return true;
          }
        }

        this.persistRuntimeState(project, task, 'ai_review', 'review', 'qa_review', 'qa_review');
        console.warn(`[AgentManager] Startup recovery rerouting completed in-progress task to QA for ${task.specId}`);
        await this.startQAProcess(task.id, project.path, task.specId, project.id);
        return this.confirmRecoveredWorkerStarted(project, task, 'QA recovery');
      }

      if ((task.status === 'ai_review' || this.shouldRetryTerminalAgentError(project, task)) && allSubtasksComplete) {
        this.persistRuntimeState(project, task, 'ai_review', 'review', 'qa_review', 'qa_review');
        console.warn(`[AgentManager] Startup recovery resuming QA for ${task.specId}`);
        await this.startQAProcess(task.id, project.path, task.specId, project.id);
        return this.confirmRecoveredWorkerStarted(project, task, 'QA recovery');
      }

      if (!hasSpec || !hasPlanSubtasks) {
        this.persistRuntimeState(project, task, 'in_progress', 'in_progress', 'planning', 'planning');
        console.warn(
          `[AgentManager] Startup recovery resuming planning for ${task.specId} ` +
          `(hasSpec=${hasSpec}, hasPlanSubtasks=${hasPlanSubtasks})`
        );
        await this.startSpecCreation(
          task.id,
          project.path,
          task.description || task.title,
          specDir,
          task.metadata,
          baseBranch,
          project.id,
        );
        return true;
      }

      this.persistRuntimeState(project, task, 'in_progress', 'in_progress', 'coding', 'coding');
      console.warn(`[AgentManager] Startup recovery resuming coding for ${task.specId}`);
      await this.startTaskExecution(
        task.id,
        project.path,
        task.specId,
        {
          parallel: false,
          workers: 1,
          baseBranch,
          useWorktree: task.metadata?.useWorktree,
          useLocalBranch: task.metadata?.useLocalBranch,
          pushNewBranches: task.metadata?.pushNewBranches,
        },
        project.id,
      );
      return this.confirmRecoveredWorkerStarted(project, task, 'coding recovery');
    } catch (error) {
      console.warn(`[AgentManager] Startup recovery could not resume ${task.specId}:`, error);
      if (!this.isRunning(task.id)) {
        this.persistRuntimeState(
          project,
          task,
          'queue',
          'queued',
          'queue',
          'idle',
          `Startup recovery could not launch ${task.specId}; queued for retry: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return false;
    }
  }

  private confirmRecoveredWorkerStarted(project: Project, task: Task, recoveryMode: string): boolean {
    if (this.isRunning(task.id)) return true;

    this.persistRuntimeState(
      project,
      task,
      'queue',
      'queued',
      'queue',
      'idle',
      `${recoveryMode} requested a worker for ${task.specId}, but no live worker was registered; queued for retry.`
    );
    console.warn(
      `[AgentManager] ${recoveryMode} requested a worker for ${task.specId}, ` +
      'but no live worker was registered; queued for retry.'
    );
    return false;
  }

  private areAllPlanSubtasksComplete(project: Project, task: Task): boolean {
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        const completion = checkSubtasksCompletion(plan);
        if (completion.totalCount > 0 && completion.allCompleted) return true;
      } catch {
        // Ignore unreadable plans; task recovery has separate guards for corrupt files.
      }
    }

    return false;
  }

  private clearMetadataOnlyQaRecovery(project: Project, task: Task): boolean {
    let persisted = false;
    const now = new Date().toISOString();

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;

        const specDir = path.dirname(planPath);
        const fixRequestPath = path.join(specDir, 'QA_FIX_REQUEST.md');
        let metadataOnly = false;

        if (existsSync(fixRequestPath)) {
          try {
            metadataOnly = isMetadataOnlyQaFailureContent(readFileSync(fixRequestPath, 'utf-8'));
          } catch {
            metadataOnly = false;
          }
        }

        const phases = Array.isArray(plan.phases) ? plan.phases : [];
        for (const phase of phases) {
          if (!Array.isArray(phase?.subtasks)) continue;
          const recoverySubtask = phase.subtasks.find((subtask: Record<string, any>) => subtask?.id === 'aperant-qa-report-failure');
          if (recoverySubtask && isMetadataOnlyQaFailureContent(String(recoverySubtask.description ?? ''))) {
            metadataOnly = true;
          }
        }

        if (!metadataOnly) continue;

        for (let index = phases.length - 1; index >= 0; index--) {
          const phase = phases[index];
          if (!Array.isArray(phase?.subtasks)) continue;
          phase.subtasks = phase.subtasks.filter((subtask: Record<string, any>) => subtask?.id !== 'aperant-qa-report-failure');
          if ((phase.id === 'aperant-qa-report-recovery' || phase.type === 'qa_report_recovery') && phase.subtasks.length === 0) {
            phases.splice(index, 1);
          }
        }

        plan.phases = phases;
        plan.status = 'ai_review';
        plan.planStatus = 'review';
        plan.xstateState = 'qa_review';
        plan.executionPhase = 'qa_review';
        plan.updated_at = now;
        plan.recoveryNote = 'Metadata-only QA failure cleared; rerunning QA instead of coding.';
        delete plan.human_feedback_pending;
        delete plan.reviewReason;
        delete plan.qa_signoff;
        delete plan.final_acceptance;

        rmSync(fixRequestPath, { force: true });
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to clear metadata-only QA recovery for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
    return persisted;
  }

  private taskHasPlanSubtasks(project: Project, task: Task): boolean {
    if (task.subtasks.length > 0) return true;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        if (checkSubtasksCompletion(plan).totalCount > 0) return true;
      } catch {
        // Ignore unreadable plans; startup recovery will surface the task state normally.
      }
    }

    return false;
  }

  private hasPendingQaReportRecovery(project: Project, task: Task): boolean {
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        const recoveryNote = typeof plan.recoveryNote === 'string' ? plan.recoveryNote : '';
        const hasQaRecoveryNote = /^QA report failed\b/.test(recoveryNote);
        const recoverySubtask = Array.isArray(plan.phases)
          ? plan.phases
            .flatMap((phase: Record<string, any>) => Array.isArray(phase?.subtasks) ? phase.subtasks : [])
            .find((subtask: Record<string, any>) => subtask?.id === 'aperant-qa-report-failure')
          : undefined;

        if (recoverySubtask) {
          if (recoverySubtask.status !== 'completed') return true;
          continue;
        }

        if (hasQaRecoveryNote) return true;
      } catch {
        // Ignore unreadable plans; normal task loading will surface JSON errors.
      }
    }

    return false;
  }

  private shouldDeferPlanningRecovery(project: Project, task: Task): boolean {
    if (this.taskHasPlanSubtasks(project, task)) return false;
    return this.countRunningProjectSpecCreationTasks(project) >= MAX_CONCURRENT_PLANNING_RECOVERIES;
  }

  private countRunningProjectSpecCreationTasks(project: Project): number {
    const tasks = projectStore.getTasks(project.id);
    return tasks.filter((task) => {
      if (!this.isRunning(task.id)) return false;
      return this.state.getProcess(task.id)?.processType === 'spec-creation';
    }).length;
  }

  private shouldRetryTerminalAgentError(project: Project, task: Task): boolean {
    if (task.status !== 'human_review' && task.status !== 'error') return false;
    if (
      task.reviewReason
      && task.reviewReason !== 'errors'
      && task.reviewReason !== 'qa_rejected'
      && task.reviewReason !== 'stopped'
    ) return false;
    if (!task.subtasks.length || task.subtasks.some((subtask) => subtask.status !== 'completed')) return false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<{
          lastEvent?: { type?: string };
          recoveryNote?: string;
        }>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        const lastEventType = plan.lastEvent?.type;
        const recoveryNote = plan.recoveryNote ?? '';
        if (lastEventType === 'QA_AGENT_ERROR' || /terminal failure blocked/i.test(recoveryNote)) {
          return true;
        }
      } catch {
        // Ignore unreadable plans; normal task loading will surface JSON errors.
      }
    }

    return false;
  }

  private shouldResumePlanningFailure(project: Project, task: Task): boolean {
    if (task.status !== 'error' && task.status !== 'human_review') return false;
    if (
      task.reviewReason
      && task.reviewReason !== 'errors'
      && task.reviewReason !== 'stopped'
    ) return false;
    if (task.subtasks.length > 0) return false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<{
          status?: string;
          executionPhase?: string;
          lastEvent?: { type?: string };
        }>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        const lastEventType = plan.lastEvent?.type ?? '';
        if (
          plan.status === 'error'
          || plan.executionPhase === 'failed'
          || lastEventType === 'PLANNING_FAILED'
          || lastEventType === 'CODING_FAILED'
        ) {
          return true;
        }
      } catch {
        // Ignore unreadable plans; normal task loading will surface JSON errors.
      }
    }

    return false;
  }

  private shouldResumeIncompleteTerminalTask(project: Project, task: Task): boolean {
    if (task.status !== 'human_review' && task.status !== 'error') return false;
    if (
      task.reviewReason
      && task.reviewReason !== 'errors'
      && task.reviewReason !== 'qa_rejected'
      && task.reviewReason !== 'stopped'
    ) return false;
    if (!task.subtasks.length || task.subtasks.every((subtask) => subtask.status === 'completed')) return false;
    if (task.reviewReason === 'stopped') return true;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<{
          lastEvent?: { type?: string };
          recoveryNote?: string;
        }>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        const lastEventType = plan.lastEvent?.type ?? '';
        const recoveryNote = plan.recoveryNote ?? '';
        if (
          lastEventType === 'PLANNING_FAILED'
          || lastEventType === 'CODING_FAILED'
          || /^QA_(?:FAILED|FIX_FAILED|MAX_ITERATIONS|REJECTED)/.test(lastEventType)
          || /blocked terminal status/i.test(recoveryNote)
        ) {
          return true;
        }
      } catch {
        // Ignore unreadable plans; normal task loading will surface JSON errors.
      }
    }

    return false;
  }

  private getMaxParallelTasks(project: Project): number {
    const configured = project.settings?.maxParallelTasks;
    return Number.isFinite(configured) && configured && configured > 0
      ? Math.floor(configured)
      : DEFAULT_MAX_PARALLEL_TASKS;
  }

  private countRunningProjectTasks(project: Project): number {
    return this.countRunningProjectWorkers(project.id);
  }

  private countRunningProjectWorkers(projectId: string): number {
    const projectsById = new Map(projectStore.getProjects().map((project) => [project.id, project]));
    return Array.from(this.state.getAllProcesses())
      .filter(([taskId, processInfo]) => {
        if (processInfo.projectId !== projectId) return false;
        if (this.isTrackedProcessLive(processInfo)) return true;
        this.clearTrackedProcess(taskId, processInfo, projectsById, 'capacity check clearing exited worker handle');
        return false;
      })
      .length;
  }

  private shouldDeferWorkerStartForProjectCapacity(
    project: Project | undefined,
    taskId: string,
    specId: string,
    phase: 'planning' | 'coding' | 'qa',
  ): boolean {
    if (!project) return false;

    if (this.isRunning(taskId)) {
      console.warn(`[AgentManager] Refusing duplicate ${phase} worker for ${specId}; task already has an active worker.`);
      return true;
    }

    const running = this.countRunningProjectWorkers(project.id);
    const maxParallelTasks = this.getMaxParallelTasks(project);
    if (running < maxParallelTasks) return false;

    console.warn(
      `[AgentManager] Deferring ${phase} worker for ${specId}: ` +
      `${running}/${maxParallelTasks} project workers are already running.`
    );

    const task = projectStore.getTasks(project.id)
      .find((candidate) => candidate.id === taskId || candidate.specId === specId);
    if (task) {
      this.deferInactiveInProgressTaskForCapacity(project, task, `capacity-${phase}`);
    }
    return true;
  }

  private deferInactiveInProgressTaskForCapacity(project: Project, task: Task, reason: string): void {
    if (task.status !== 'in_progress' || this.isRunning(task.id)) return;

    if (this.areAllPlanSubtasksComplete(project, task)) {
      this.persistRuntimeState(project, task, 'ai_review', 'review', 'qa_review', 'qa_review');
      console.warn(`[AgentManager] ${reason} deferred completed task ${task.specId} to QA review while capacity is full`);
      return;
    }

    this.persistRuntimeState(project, task, 'queue', 'queued', 'queue', 'idle');
    console.warn(`[AgentManager] ${reason} moved inactive in-progress task ${task.specId} back to queue while capacity is full`);
  }

  private persistRuntimeState(
    project: Project,
    task: Task,
    status: Task['status'],
    planStatus: string,
    xstateState: string,
    executionPhase: string,
    recoveryNote?: string,
  ): void {
    let persisted = false;
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        plan.status = status;
        plan.planStatus = planStatus;
        plan.xstateState = xstateState;
        plan.executionPhase = executionPhase;
        plan.updated_at = new Date().toISOString();
        if (status !== 'human_review') delete plan.reviewReason;
        if (recoveryNote) {
          plan.recoveryNote = recoveryNote;
        }
        if (status === 'ai_review') {
          delete plan.qa_signoff;
          delete plan.final_acceptance;
          delete plan.lastEvent;
        }
        if (status === 'queue' || status === 'in_progress') {
          clearStaleCompletionMetadataForActivePlan(plan);
        }
        const hasResolvedRecovery = hasResolvedRecoverySubtasks(plan);
        clearResolvedRecoveryState(plan);
        if (hasResolvedRecovery) {
          const artifactNames = [
            ...(plan.human_feedback_pending === undefined ? ['QA_FIX_REQUEST.md', 'QA_ESCALATION.md'] : []),
            ...(plan.base_sync_conflict === undefined ? ['BASE_SYNC_CONFLICT.md'] : []),
          ];
          for (const fileName of artifactNames) {
            try {
              rmSync(path.join(path.dirname(planPath), fileName), { force: true });
            } catch {
              // Best effort cleanup for stale resolved-recovery artifacts.
            }
          }
        }
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to persist startup runtime state for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private async resumeCodingForBaseSyncConflict(
    project: Project,
    task: Task,
    conflictFiles: string[],
    reason = 'base_sync_conflict',
  ): Promise<void> {
    this.persistBaseSyncConflictForCoding(project, task, conflictFiles, reason);
    const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;
    await this.startTaskExecution(
      task.id,
      project.path,
      task.specId,
      {
        parallel: false,
        workers: 1,
        baseBranch,
        useWorktree: task.metadata?.useWorktree,
        useLocalBranch: task.metadata?.useLocalBranch,
        pushNewBranches: task.metadata?.pushNewBranches,
      },
      project.id,
    );
  }

  async resumeCodingForFailedQaReport(project: Project, task: Task): Promise<boolean> {
    const failure = this.findFailedQaReport(project, task);
    if (!failure) return false;

    this.persistQaReportFailureForCoding(project, task, failure.content, failure.reportPath);
    taskStateManager.prepareForRestart(task.id);

    const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch;
    await this.startTaskExecution(
      task.id,
      project.path,
      task.specId,
      {
        parallel: false,
        workers: 1,
        baseBranch,
        useWorktree: task.metadata?.useWorktree,
        useLocalBranch: task.metadata?.useLocalBranch,
        pushNewBranches: task.metadata?.pushNewBranches,
      },
      project.id,
    );
    return this.confirmRecoveredWorkerStarted(project, task, 'failed QA coding recovery');
  }

  hasFailedQaReport(project: Project, task: Task): boolean {
    return this.findFailedQaReport(project, task) !== null;
  }

  private findFailedQaReport(project: Project, task: Task): { reportPath: string; content: string } | null {
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      const failure = readFailedQaEvidenceSync(path.dirname(planPath));
      if (failure) {
        return failure;
      }
    }
    return null;
  }

  private persistQaReportFailureForCoding(
    project: Project,
    task: Task,
    reportContent: string,
    reportPath: string,
  ): void {
    const now = new Date().toISOString();
    const recoverySubtaskId = 'aperant-qa-report-failure';
    const fallbackFailureContent = this.collectQaFailureFallback(project, task, reportPath);
    const reportExcerpt = normalizeQaFailureEvidenceContent(reportContent, fallbackFailureContent).slice(0, 8000);
    let persisted = false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;

        const phases = Array.isArray(plan.phases) ? plan.phases : [];
        let phase = phases.find((candidate: Record<string, any>) => candidate?.id === 'aperant-qa-report-recovery' || candidate?.type === 'qa_report_recovery');
        if (!phase) {
          phase = {
            id: 'aperant-qa-report-recovery',
            phase: phases.length + 1,
            name: 'QA report recovery',
            type: 'qa_report_recovery',
            status: 'in_progress',
            subtasks: [],
          };
          phases.push(phase);
        }

        const specDir = path.dirname(planPath);
        const fixRequestPath = path.join(specDir, 'QA_FIX_REQUEST.md');
        const recoveryDescription = [
          'Resolve the failed QA report and return this task to a passing review state.',
          '',
          `QA evidence source: ${reportPath}`,
          `Active fix request: ${fixRequestPath}`,
          '',
          'Read QA_FIX_REQUEST.md first. Read qa_report.md only if it exists in this spec directory.',
          '',
          'Failed QA report:',
          '```markdown',
          reportExcerpt || '(empty qa_report.md)',
          '```',
          '',
          'Do not mark this subtask complete until the reported issues are addressed, focused verification is recorded, and the next QA run can pass.',
        ].join('\n');
        const recoveryVerification = 'Read QA_FIX_REQUEST.md first, run focused verification for the reported failures, then rerun QA.';

        const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : [];
        let recoverySubtask = subtasks.find((subtask: Record<string, any>) => subtask?.id === recoverySubtaskId);
        if (!recoverySubtask) {
          recoverySubtask = {
            id: recoverySubtaskId,
            title: 'Resolve failed QA report',
            description: recoveryDescription,
            status: 'pending',
            verification: {
              type: 'command',
              run: recoveryVerification,
            },
          };
          subtasks.push(recoverySubtask);
        } else {
          recoverySubtask.title = 'Resolve failed QA report';
          recoverySubtask.description = recoveryDescription;
          recoverySubtask.status = recoverySubtask.status === 'in_progress'
            ? 'in_progress'
            : 'pending';
          delete recoverySubtask.completed_at;
          delete recoverySubtask.completion_note;
          delete recoverySubtask.qa_signoff;
          delete recoverySubtask.last_error;
          delete recoverySubtask.last_attempt_outcome;
          delete recoverySubtask.last_attempt_at;
          recoverySubtask.verification = {
            type: 'command',
            run: recoveryVerification,
          };
        }

        phase.subtasks = subtasks;
        phase.status = 'in_progress';
        plan.phases = phases;
        plan.status = 'in_progress';
        plan.planStatus = 'in_progress';
        plan.xstateState = 'coding';
        plan.executionPhase = 'coding';
        plan.updated_at = now;
        plan.recoveryNote = 'QA report failed; continuing coding with QA findings as mandatory recovery work.';
        plan.human_feedback_pending = {
          requested_at: now,
          preview: reportExcerpt.slice(0, 500),
          source: 'qa_report',
        };
        plan.lastEvent = {
          eventId: `qa-report-failed-${Date.now()}`,
          sequence: 0,
          type: 'QA_REPORT_FAILED',
          timestamp: now,
        };
        delete plan.reviewReason;
        delete plan.qa_signoff;
        delete plan.final_acceptance;

        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        writeFileAtomicSync(
          fixRequestPath,
          buildQaFixRequestContent(reportExcerpt, now, fallbackFailureContent),
        );
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to persist QA report recovery for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private collectQaFailureFallback(project: Project, task: Task, reportPath: string): string | null {
    const parts: string[] = [];

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      const specDir = path.dirname(planPath);

      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        const subtasks = Array.isArray(plan?.phases)
          ? plan.phases.flatMap((phase: Record<string, any>) => Array.isArray(phase.subtasks) ? phase.subtasks : [])
          : [];
        const recoverySubtask = subtasks.find((subtask: Record<string, any>) => subtask?.id === 'aperant-qa-report-failure');
        const notes = typeof recoverySubtask?.notes === 'string' ? recoverySubtask.notes.trim() : '';
        const lastError = typeof recoverySubtask?.last_error === 'string' ? recoverySubtask.last_error.trim() : '';
        if (notes) parts.push(`Persisted recovery notes:\n${notes}`);
        if (lastError) parts.push(`Last recovery error:\n${lastError}`);
      } catch {
        // Keep gathering file-based evidence below.
      }

      for (const fileName of ['qa_report.md', 'QA_FIX_REQUEST.md', 'QA_ESCALATION.md', 'build-progress.txt']) {
        const evidencePath = path.join(specDir, fileName);
        if (evidencePath === reportPath || !existsSync(evidencePath)) continue;
        try {
          const content = readFileSync(evidencePath, 'utf-8').trim();
          if (content) parts.push(`${fileName}:\n${compactQaFallbackEvidence(content)}`);
        } catch {
          // Non-fatal; this fallback is best effort.
        }
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  private persistBaseSyncConflictForCoding(
    project: Project,
    task: Task,
    conflictFiles: string[],
    reason: string,
  ): void {
    const now = new Date().toISOString();
    const normalizedFiles = conflictFiles.length > 0 ? conflictFiles : ['unknown conflicted paths'];
    const recoverySubtaskId = BASE_SYNC_RECOVERY_SUBTASK_ID;
    const recoveryDescription = [
      'Resolve the Git conflict markers created while updating this task worktree to the current base branch.',
      '',
      'Conflicted files:',
      ...normalizedFiles.map((file) => `- ${file}`),
      '',
      'Preserve the task implementation and current base-branch behavior. Do not mark this subtask complete until `git diff --name-only --diff-filter=U` returns no files and focused verification for the touched area is recorded.',
    ].join('\n');
    let persisted = false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;

        const conflictDocPath = path.join(path.dirname(planPath), 'BASE_SYNC_CONFLICT.md');
        if (isBaseSyncConflictRecoveryCurrent(plan, normalizedFiles, reason, recoveryDescription)) {
          if (!existsSync(conflictDocPath)) {
            writeFileAtomicSync(
              conflictDocPath,
              [
                '# Base Branch Sync Conflict',
                '',
                `Aperant updated this task worktree against the base branch and found unresolved Git conflicts at ${now}.`,
                '',
                'Resolve these files before returning to QA:',
                ...normalizedFiles.map((file) => `- ${file}`),
                '',
                'After resolving, run focused verification and update implementation_plan.json.',
                '',
              ].join('\n'),
            );
          }
          continue;
        }

        const phases = Array.isArray(plan.phases) ? plan.phases : [];
        let phase = phases.find((candidate: Record<string, any>) => candidate?.id === 'aperant-base-sync-recovery' || candidate?.type === 'base_sync_recovery');
        if (!phase) {
          phase = {
            id: 'aperant-base-sync-recovery',
            phase: phases.length + 1,
            name: 'Base branch sync recovery',
            type: 'base_sync_recovery',
            status: 'in_progress',
            subtasks: [],
          };
          phases.push(phase);
        }

        const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : [];
        let recoverySubtask = subtasks.find((subtask: Record<string, any>) => subtask?.id === recoverySubtaskId);
        if (!recoverySubtask) {
          recoverySubtask = {
            id: recoverySubtaskId,
            title: 'Resolve base branch sync conflicts',
            description: recoveryDescription,
            status: 'pending',
            verification: {
              type: 'command',
              run: 'git diff --name-only --diff-filter=U && git status --short',
            },
          };
          subtasks.push(recoverySubtask);
        } else {
          recoverySubtask.title = 'Resolve base branch sync conflicts';
          recoverySubtask.description = recoveryDescription;
          recoverySubtask.status = recoverySubtask.status === 'in_progress' ? 'in_progress' : 'pending';
          recoverySubtask.verification = {
            type: 'command',
            run: 'git diff --name-only --diff-filter=U && git status --short',
          };
        }

        phase.subtasks = subtasks;
        phase.status = 'in_progress';
        plan.phases = phases;
        plan.status = 'in_progress';
        plan.planStatus = 'in_progress';
        plan.xstateState = 'coding';
        plan.executionPhase = 'coding';
        delete plan.reviewReason;
        plan.updated_at = now;
        plan.recoveryNote = BASE_SYNC_RECOVERY_NOTE;
        plan.base_sync_conflict = {
          files: normalizedFiles,
          reason,
          updated_at: now,
        };
        plan.lastEvent = {
          eventId: `base-sync-conflict-${Date.now()}`,
          sequence: 0,
          type: 'BASE_SYNC_CONFLICT',
          timestamp: now,
        };
        delete plan.qa_signoff;
        delete plan.final_acceptance;

        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        writeFileAtomicSync(
          conflictDocPath,
          [
            '# Base Branch Sync Conflict',
            '',
            `Aperant updated this task worktree against the base branch and found unresolved Git conflicts at ${now}.`,
            '',
            'Resolve these files before returning to QA:',
            ...normalizedFiles.map((file) => `- ${file}`),
            '',
            'After resolving, run focused verification and update implementation_plan.json.',
            '',
          ].join('\n'),
        );
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to persist base sync conflict recovery for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private persistWorktreeSetupFailure(
    project: Project | undefined,
    task: Task | undefined,
    message: string,
  ): void {
    if (!project || !task) return;
    const now = new Date().toISOString();
    let persisted = false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;

        plan.status = 'in_progress';
        plan.planStatus = 'in_progress';
        plan.xstateState = 'coding';
        plan.executionPhase = 'coding';
        plan.recoveryNote = `Worktree setup failed; Aperant refused to run task code in the main checkout: ${message}`;
        plan.lastEvent = {
          eventId: `worktree-setup-failed-${Date.now()}`,
          sequence: 0,
          type: 'WORKTREE_SETUP_FAILED',
          timestamp: now,
        };
        plan.updated_at = now;
        delete plan.reviewReason;

        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to persist worktree setup failure for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  private clearRecoveredWorktreeSetupFailure(
    project: Project,
    task: Task,
  ): void {
    let persisted = false;

    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, any>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        if (typeof plan.recoveryNote !== 'string' || !plan.recoveryNote.startsWith('Worktree setup failed;')) continue;

        delete plan.recoveryNote;
        if (plan.lastEvent?.type === 'WORKTREE_SETUP_FAILED') {
          delete plan.lastEvent;
        }
        plan.updated_at = new Date().toISOString();
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
        persisted = true;
      } catch (error) {
        console.warn(`[AgentManager] Failed to clear recovered worktree setup failure for ${task.specId}:`, error);
      }
    }

    if (persisted) {
      projectStore.invalidateTasksCache(project.id);
    }
  }

  /**
   * Register a task with the unified OperationRegistry for proactive swap support.
   * Extracted helper to avoid code duplication between spec creation and task execution.
   * @private
   */
  private registerTaskWithOperationRegistry(
    taskId: string,
    operationType: 'spec-creation' | 'task-execution',
    metadata: Record<string, unknown>
  ): void {
    const profileManager = getClaudeProfileManager();
    const activeProfile = profileManager.getActiveProfile();
    if (!activeProfile) {
      return;
    }

    // Keep internal state tracking for backward compatibility
    this.assignProfileToTask(taskId, activeProfile.id, activeProfile.name, 'proactive');

    // Register with unified registry for proactive swap
    // Note: We don't provide a stopFn because restartTask() already handles stopping
    // the task internally via killTask() before restarting. Providing a separate
    // stopFn would cause a redundant double-kill during profile swaps.
    const operationRegistry = getOperationRegistry();
    operationRegistry.registerOperation(
      taskId,
      operationType,
      activeProfile.id,
      activeProfile.name,
      (newProfileId: string) => this.restartTask(taskId, newProfileId),
      { metadata }
    );
    console.log('[AgentManager] Task registered with OperationRegistry:', {
      taskId,
      profileId: activeProfile.id,
      profileName: activeProfile.name,
      type: operationType
    });
  }

  /**
   * Start spec creation process
   */
  async startSpecCreation(
    taskId: string,
    projectPath: string,
    taskDescription: string,
    specDir?: string,
    metadata?: SpecCreationMetadata,
    baseBranch?: string,
    projectId?: string
  ): Promise<void> {
    // Pre-flight auth check: Verify active profile has valid authentication
    // Ensure profile manager is initialized to prevent race condition
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const resolvedProjectId = projectId ?? project?.id;
    const resolvedSpecDir = specDir ?? path.join(projectPath, '.auto-claude', 'specs', taskId);
    const specId = path.basename(resolvedSpecDir);
    if (this.shouldDeferWorkerStartForProjectCapacity(project, taskId, specId, 'planning')) {
      return;
    }

    // Reset stuck subtasks if restarting an existing spec creation task
    if (specDir) {
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      console.log('[AgentManager] Resetting stuck subtasks before spec creation restart:', planPath);
      try {
        const { success, resetCount } = await resetStuckSubtasks(planPath);
        if (success && resetCount > 0) {
          console.log(`[AgentManager] Successfully reset ${resetCount} stuck subtask(s) before spec creation`);
        }
      } catch (err) {
        console.warn('[AgentManager] Failed to reset stuck subtasks before spec creation:', err);
      }
    }

    // Resolve model and thinking level for the spec phase
    const specModelShorthand = metadata?.phaseModels?.spec
      ? metadata.phaseModels.spec
      : (metadata?.model ?? 'sonnet');

    // Determine the preferred provider (from metadata or task_metadata.json)
    const preferredProvider = (
      specDir ? this.resolveTaskPhaseProvider(specDir, 'spec') : null
    ) ?? (metadata?.provider as string | undefined) ?? null;

    // Resolve the model ID, translating to the target provider's equivalent if needed
    let specModelId: string;
    if (preferredProvider && preferredProvider !== 'anthropic') {
      const equiv = resolveModelEquivalent(specModelShorthand, preferredProvider as BuiltinProvider)
        ?? resolveModelEquivalent(resolveModelId(specModelShorthand), preferredProvider as BuiltinProvider);
      specModelId = equiv?.modelId ?? specModelShorthand;
    } else {
      specModelId = resolveModelId(specModelShorthand);
    }

    // Load system prompt from prompts directory
    const systemPrompt = this.loadPrompt('spec_orchestrator') ?? this.buildDefaultSpecPrompt(taskDescription, specDir);

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    const resolved = await this.resolveAuthFromProviderQueue(specModelId, preferredProvider);

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'spec_orchestrator' as const,
      systemPrompt,
      phase: 'spec' as const,
      initialMessages: [
        {
          role: 'user',
          content: `Task: ${taskDescription}\n\nProject directory: ${projectPath}${specDir ? `\nSpec directory: ${specDir}` : ''}${baseBranch ? `\nBase branch: ${baseBranch}` : ''}${metadata?.requireReviewBeforeCoding ? '\nRequire review before coding: true' : '\nAuto-approve: true'}`,
        },
      ],
      maxSteps: 250,
      specDir: resolvedSpecDir,
      projectDir: projectPath,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: buildSessionMcpOptions(projectPath, project, 'spec_orchestrator'),
      toolContext: {
        cwd: projectPath,
        projectDir: projectPath,
        specDir: resolvedSpecDir,
        securityProfile: this.serializeSecurityProfile(projectPath),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId: resolvedProjectId,
      processType: 'spec-creation',
      session: sessionConfig,
    };

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, '', {}, true, taskDescription, specDir, metadata, baseBranch, resolvedProjectId);

    // Register with unified OperationRegistry for proactive swap support
    this.registerTaskWithOperationRegistry(taskId, 'spec-creation', { projectPath, taskDescription, specDir });

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'spec-creation', resolvedProjectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [specRunnerPath, '--task', taskDescription, '--project-dir', projectPath];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start task execution (build orchestrator)
   */
  async startTaskExecution(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions = {},
    projectId?: string
  ): Promise<void> {
    // Pre-flight auth check: Verify active profile has valid authentication
    // Ensure profile manager is initialized to prevent race condition
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const resolvedProjectId = projectId ?? project?.id;
    const task = project ? projectStore.getTasks(project.id).find((candidate) => candidate.id === taskId || candidate.specId === specId) : undefined;
    if (this.shouldDeferWorkerStartForProjectCapacity(project, taskId, specId, 'coding')) {
      return;
    }
    const specsBaseDir = getSpecsDir(project?.autoBuildPath);
    const specDir = path.join(projectPath, specsBaseDir, specId);

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'planning');
    const preferredProvider = this.resolveTaskPhaseProvider(specDir, 'planning');

    // Load system prompt (planner prompt for build orchestrator entry point)
    const systemPrompt = this.loadPrompt('planner') ?? this.buildDefaultPlannerPrompt(specId, projectPath);

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    const resolved = await this.resolveAuthFromProviderQueue(modelId, preferredProvider);

    // Create or get existing git worktree for task isolation
    // This matches the Python backend's WorktreeManager.create_worktree() behavior
    let worktreePath: string | null = null;
    let worktreeSpecDir = specDir;
    const useWorktree = options.useWorktree !== false; // Default to true (matching Python backend)
    cleanupStaleRateLimitPauseFile(specDir);
    if (useWorktree) {
      try {
        const baseBranch = options.baseBranch ?? project?.settings?.mainBranch ?? 'main';
        const result = await createOrGetWorktree(
          projectPath,
          specId,
          baseBranch,
          options.useLocalBranch ?? false,
          project?.settings?.pushNewBranches !== false,
          project?.autoBuildPath,
        );
        worktreePath = result.worktreePath;
        // Spec dir in the worktree (spec files were copied by createOrGetWorktree)
        worktreeSpecDir = path.join(worktreePath, specsBaseDir, specId);
        cleanupStaleRateLimitPauseFile(worktreeSpecDir);
        const syncCheck = await syncWorktreeWithBaseBranch(projectPath, worktreePath, baseBranch);
        if (syncCheck.conflicted && project && task) {
          const conflictFiles = syncCheck.conflictFiles ?? [];
          console.warn(
            `[AgentManager] Coding worktree for ${specId} has base-sync conflicts; adding recovery subtask: ${conflictFiles.join(', ') || 'unknown files'}`
          );
          this.persistBaseSyncConflictForCoding(project, task, conflictFiles, syncCheck.skippedReason ?? 'base_sync_conflict');
        }
        if (project && task) {
          this.clearRecoveredWorktreeSetupFailure(project, task);
        }
        console.warn(`[AgentManager] Task ${taskId} will run in worktree: ${worktreePath}`);
      } catch (err) {
        console.error(`[AgentManager] Failed to create worktree for ${taskId}:`, err);
        const message = err instanceof Error ? err.message : String(err);
        this.persistWorktreeSetupFailure(project, task, message);
        this.emit('error', taskId, `Could not prepare isolated task worktree. Refusing to run task in the main project checkout: ${message}`, projectId);
        return;
      }
    }

    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;

    // Load initial context from spec directory
    const initialMessages = this.buildTaskExecutionMessages(worktreeSpecDir, specId, effectiveProjectDir);

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'build_orchestrator' as const,
      systemPrompt,
      initialMessages,
      maxSteps: 250,
      specDir: worktreeSpecDir,
      projectDir: effectiveProjectDir,
      // When running in a worktree, sourceSpecDir points to the main project spec dir
      // so the subtask iterator can sync phase updates in real time (not just on exit).
      sourceSpecDir: worktreePath ? specDir : undefined,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: buildSessionMcpOptions(projectPath, project, 'build_orchestrator'),
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: worktreeSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId: resolvedProjectId,
      processType: 'task-execution',
      session: sessionConfig,
    };

    // Store context for potential restart
    this.storeTaskContext(taskId, projectPath, specId, options, false, undefined, undefined, undefined, undefined, resolvedProjectId);

    // Register with unified OperationRegistry for proactive swap support
    this.registerTaskWithOperationRegistry(taskId, 'task-execution', { projectPath, specId, options });

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'task-execution', resolvedProjectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--auto-continue', '--force'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'task-execution', projectId);
  }

  /**
   * Start QA process (qa_reviewer agent)
   */
  async startQAProcess(
    taskId: string,
    projectPath: string,
    specId: string,
    projectId?: string
  ): Promise<void> {
    // Ensure profile manager is initialized for auth resolution
    let profileManager: ClaudeProfileManager;
    try {
      profileManager = await initializeClaudeProfileManager();
    } catch (error) {
      console.error('[AgentManager] Failed to initialize profile manager:', error);
      this.emit('error', taskId, 'Failed to initialize profile manager. Please check file permissions and disk space.');
      return;
    }
    if (!profileManager.hasValidAuth() && !this.hasAnyProviderAccount()) {
      this.emit('error', taskId, 'Authentication required. Please add an account in Settings > Accounts before starting tasks.');
      return;
    }

    // Resolve the spec directory from specId
    const project = projectStore.getProjects().find((p) => p.id === projectId || p.path === projectPath);
    const resolvedProjectId = projectId ?? project?.id;
    if (this.shouldDeferWorkerStartForProjectCapacity(project, taskId, specId, 'qa')) {
      return;
    }
    const specsBaseDir = getSpecsDir(project?.autoBuildPath);
    const specDir = path.join(projectPath, specsBaseDir, specId);

    // Load model configuration from task_metadata.json if available
    const modelId = await this.resolveTaskModelId(specDir, 'qa');
    const preferredProvider = this.resolveTaskPhaseProvider(specDir, 'qa');

    // Load system prompt for QA reviewer
    const systemPrompt = this.loadPrompt('qa_reviewer') ?? this.buildDefaultQAPrompt(specId, projectPath);

    // Resolve auth from provider accounts priority queue (falls back to legacy profile)
    const resolved = await this.resolveAuthFromProviderQueue(modelId, preferredProvider);

    // Find existing worktree for QA (created during task execution)
    const worktreePath = findTaskWorktree(projectPath, specId);
    const task = project ? projectStore.getTasks(project.id).find((candidate) => candidate.id === taskId || candidate.specId === specId) : undefined;
    const baseBranch = task?.metadata?.baseBranch || project?.settings?.mainBranch || 'main';
    if (worktreePath) {
      try {
        const syncResult = await syncWorktreeWithBaseBranch(projectPath, worktreePath, baseBranch);
        if (syncResult.conflicted) {
          const conflictFiles = syncResult.conflictFiles ?? [];
          if (project && task) {
            console.warn(
              `[AgentManager] QA worktree for ${specId} has base-sync conflicts; returning task to coding: ${conflictFiles.join(', ') || 'unknown files'}`
            );
            await this.resumeCodingForBaseSyncConflict(project, task, conflictFiles, syncResult.skippedReason);
          } else {
            this.emit('error', taskId, `Task worktree has unresolved base-sync conflicts: ${conflictFiles.join(', ') || 'unknown files'}`);
          }
          return;
        }
        if (syncResult.synced) {
          console.warn(`[AgentManager] Synced QA worktree for ${specId} with ${baseBranch}${syncResult.stashed ? ' (stashed task edits)' : ''}`);
        }
      } catch (error) {
        console.warn(`[AgentManager] Could not sync QA worktree for ${specId}:`, error);
        this.emit('error', taskId, `Could not sync task worktree with ${baseBranch}. Resolve worktree conflicts and retry QA.`);
        return;
      }
    } else if (task?.metadata?.useWorktree !== false) {
      this.emit('error', taskId, 'No isolated task worktree found for QA. Refusing to run QA in the main project checkout.');
      return;
    }
    const effectiveCwd = worktreePath ?? projectPath;
    const effectiveProjectDir = worktreePath ?? projectPath;
    const effectiveSpecDir = worktreePath
      ? path.join(worktreePath, specsBaseDir, specId)
      : specDir;

    if (worktreePath) {
      console.warn(`[AgentManager] QA for ${taskId} will run in worktree: ${worktreePath}`);
    } else {
      console.warn(`[AgentManager] No worktree found for ${taskId}, QA running in project root`);
    }

    try {
      rmSync(path.join(effectiveSpecDir, AUTO_BUILD_PATHS.QA_REPORT), { force: true });
    } catch {
      // Stale QA reports are best-effort cleanup; the reviewer can still overwrite.
    }

    // Load initial context from spec directory
    const qaInitialMessages = this.buildQAInitialMessages(effectiveSpecDir, specId, effectiveProjectDir);

    // Build the serializable session config for the worker
    const sessionConfig: SerializableSessionConfig = {
      agentType: 'qa_reviewer',
      systemPrompt,
      initialMessages: qaInitialMessages,
      maxSteps: 200,
      specDir: effectiveSpecDir,
      projectDir: effectiveProjectDir,
      sourceSpecDir: worktreePath ? specDir : undefined,
      provider: resolved.provider,
      modelId: resolved.modelId,
      apiKey: resolved.auth?.apiKey,
      baseURL: resolved.auth?.baseURL,
      configDir: resolved.configDir,
      oauthTokenFilePath: resolved.auth?.oauthTokenFilePath,
      mcpOptions: buildSessionMcpOptions(projectPath, project, 'qa_reviewer'),
      toolContext: {
        cwd: effectiveCwd,
        projectDir: effectiveProjectDir,
        specDir: effectiveSpecDir,
        securityProfile: this.serializeSecurityProfile(effectiveProjectDir),
      },
    };

    const executorConfig: AgentExecutorConfig = {
      taskId,
      projectId: resolvedProjectId,
      processType: 'qa-process',
      session: sessionConfig,
    };

    await this.processManager.spawnWorkerProcess(taskId, executorConfig, {}, 'qa-process', resolvedProjectId);

    // Note (Python fallback preserved for reference):
    // const combinedEnv = this.processManager.getCombinedEnv(projectPath);
    // const args = [runPath, '--spec', specId, '--project-dir', projectPath, '--qa'];
    // await this.processManager.spawnProcess(taskId, projectPath, args, combinedEnv, 'qa-process', projectId);
  }

  /**
   * Start roadmap generation process
   */
  startRoadmapGeneration(
    projectId: string,
    projectPath: string,
    refresh: boolean = false,
    enableCompetitorAnalysis: boolean = false,
    refreshCompetitorAnalysis: boolean = false,
    config?: RoadmapConfig
  ): void {
    this.queueManager.startRoadmapGeneration(projectId, projectPath, refresh, enableCompetitorAnalysis, refreshCompetitorAnalysis, config);
  }

  /**
   * Start ideation generation process
   */
  startIdeationGeneration(
    projectId: string,
    projectPath: string,
    config: IdeationConfig,
    refresh: boolean = false
  ): void {
    this.queueManager.startIdeationGeneration(projectId, projectPath, config, refresh);
  }

  scheduleHumanReviewMerge(reason = 'scheduled', delayMs = 2500): void {
    if (process.env.APERANT_AUTO_MERGE_HUMAN_REVIEW === 'false') return;
    if (this.humanReviewMergeTimer) clearTimeout(this.humanReviewMergeTimer);
    this.humanReviewMergeTimer = setTimeout(() => {
      this.humanReviewMergeTimer = null;
      this.mergeCompletedHumanReviewTasks(reason).catch((error) => {
        console.error('[AgentManager] Human-review merge scan failed:', error);
      });
    }, delayMs);
  }

  private async mergeCompletedHumanReviewTasks(reason: string): Promise<void> {
    if (this.humanReviewMergeInProgress) return;
    this.humanReviewMergeInProgress = true;
    try {
      const projects = projectStore.getProjects();
      for (const project of projects) {
        const tasks = projectStore.getTasks(project.id);
        for (const task of tasks) {
          if (!this.shouldAutoMergeHumanReviewTask(project, task)) continue;
          try {
            const qaEvidence = this.getHumanReviewQaEvidence(project, task);
            if (!qaEvidence.passingReportPath) {
              await this.resumeQaForMissingPassingReport(project, task);
              console.warn(`[AgentManager] Auto-merge deferred for ${task.specId}: missing passing qa_report.md; rerunning QA (${reason})`);
              continue;
            }

            const result = await this.mergeHumanReviewTask(project, task);
            if (result.success) {
              console.warn(`[AgentManager] Auto-merged human-review task ${task.specId} (${reason})${result.commitSha ? ` at ${result.commitSha}` : ''}`);
            } else {
              console.warn(`[AgentManager] Auto-merge skipped for ${task.specId}: ${result.message}`);
            }
          } catch (error) {
            console.warn(`[AgentManager] Auto-merge failed for ${task.specId}:`, error);
          }
        }
      }
    } finally {
      this.humanReviewMergeInProgress = false;
    }
  }

  private shouldAutoMergeHumanReviewTask(project: Project, task: Task): boolean {
    if (this.isRunning(task.id)) return false;
    const persistedPlans = this.readHumanReviewPlanCandidates(project, task);
    return canAutoMergeCompletedHumanReviewTask(task, persistedPlans)
      || canAutoMergeCompletedHumanReviewPlans(persistedPlans);
  }

  private readHumanReviewPlanCandidates(project: Project, task: Task): Array<Record<string, unknown>> {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const planPaths = [
      path.join(project.path, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    ];
    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (worktreePath && existsSync(worktreePath)) {
      planPaths.push(path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN));
    }

    const plans: Array<Record<string, unknown>> = [];
    for (const planPath of planPaths) {
      if (!existsSync(planPath)) continue;
      const parsed = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
      if (parsed) plans.push(parsed);
    }
    return plans;
  }

  private getHumanReviewQaEvidence(project: Project, task: Task): {
    mainSpecDir: string;
    worktreeSpecDir?: string;
    passingReportPath: string | null;
  } {
    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const mainSpecDir = path.join(project.path, specsBaseDir, task.specId);
    const worktreePath = findTaskWorktree(project.path, task.specId);
    const worktreeSpecDir = worktreePath && existsSync(worktreePath)
      ? path.join(worktreePath, specsBaseDir, task.specId)
      : undefined;
    const specDirs = [
      worktreeSpecDir,
      mainSpecDir,
    ].filter((candidate): candidate is string => Boolean(candidate));

    return {
      mainSpecDir,
      worktreeSpecDir,
      passingReportPath: findPassingQaReport(specDirs),
    };
  }

  private async resumeQaForMissingPassingReport(project: Project, task: Task): Promise<void> {
    this.persistRuntimeState(project, task, 'ai_review', 'review', 'qa_review', 'qa_review');
    taskStateManager.prepareForRestart(task.id);
    await this.startQAProcess(task.id, project.path, task.specId, project.id);
  }

  private async mergeHumanReviewTask(project: Project, task: Task): Promise<{ success: boolean; message: string; commitSha?: string }> {
    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (!worktreePath || !existsSync(worktreePath)) {
      return { success: false, message: 'No task worktree found' };
    }

    const baseBranch = task.metadata?.baseBranch || project.settings?.mainBranch || 'main';
    try {
      const syncResult = await syncWorktreeWithBaseBranch(project.path, worktreePath, baseBranch);
      if (syncResult.conflicted) {
        const conflictFiles = syncResult.conflictFiles ?? [];
        await this.resumeCodingForBaseSyncConflict(project, task, conflictFiles, syncResult.skippedReason);
        return {
          success: false,
          message: `Worktree has base-sync conflicts; resumed coding to resolve ${conflictFiles.join(', ') || 'conflicted files'}`,
        };
      }
      if (syncResult.synced) {
        console.warn(`[AgentManager] Synced merge worktree for ${task.specId} with ${baseBranch}${syncResult.stashed ? ' (stashed task edits)' : ''}`);
      }
    } catch (error) {
      return { success: false, message: `Could not sync worktree with ${baseBranch}: ${error instanceof Error ? error.message : String(error)}` };
    }

    const qaEvidence = this.getHumanReviewQaEvidence(project, task);
    if (!qaEvidence.passingReportPath) {
      await this.resumeQaForMissingPassingReport(project, task);
      return { success: false, message: 'Missing passing qa_report.md; rerunning QA before merge' };
    }
    if (qaEvidence.worktreeSpecDir) {
      const copied = copyReviewArtifactsToMainSpec(qaEvidence.mainSpecDir, qaEvidence.worktreeSpecDir);
      if (copied.length > 0) {
        console.warn(`[AgentManager] Preserved review artifacts for ${task.specId}: ${copied.join(', ')}`);
      }
    }

    const storageDir = path.join(project.path, project.autoBuildPath || '.auto-claude');
    const orchestrator = new MergeOrchestrator({
      projectDir: project.path,
      storageDir,
      enableAi: true,
      aiResolver: createMergeResolverFn('haiku', 'low'),
      dryRun: false,
    });

    const report = await orchestrator.mergeTask(task.specId, worktreePath, baseBranch);
    if (!report.success) {
      return { success: false, message: report.error ?? 'Merge failed' };
    }

    const mergedFilePaths = orchestrator.getApplicableFilePaths(report);
    if (mergedFilePaths.length === 0) {
      const alreadyMerged = await this.finalizeAlreadyMergedHumanReviewTask(project, task, worktreePath, 'Merge produced no files to apply');
      if (alreadyMerged) return alreadyMerged;
      return { success: false, message: 'Merge produced no files to apply' };
    }

    if (!orchestrator.applyToProject(report)) {
      return { success: false, message: 'Failed to apply merged files to project directory' };
    }

    const stageableFilePaths = orchestrator.getStageableFilePaths(report);
    if (stageableFilePaths.length === 0) {
      const alreadyMerged = await this.finalizeAlreadyMergedHumanReviewTask(project, task, worktreePath, 'Merge applied but produced no stageable file changes');
      if (alreadyMerged) return alreadyMerged;
      return { success: false, message: 'Merge applied but produced no stageable file changes' };
    }

    execFileSync(getToolPath('git'), ['add', '--', ...stageableFilePaths], {
      cwd: project.path,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
    });

    const stagedNames = execFileSync(getToolPath('git'), ['diff', '--cached', '--name-only', '--', ...stageableFilePaths], {
      cwd: project.path,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
    }).trim();
    if (!stagedNames) {
      const alreadyMerged = await this.finalizeAlreadyMergedHumanReviewTask(project, task, worktreePath, 'Merge applied but produced no staged changes');
      if (alreadyMerged) return alreadyMerged;
      return { success: false, message: 'Merge applied but produced no staged changes' };
    }

    const commitTitle = String(task.title || task.specId).replace(/\s+/g, ' ').trim();
    execFileSync(getToolPath('git'), ['commit', '-m', `Auto-merge ${task.specId}: ${commitTitle}`, '--', ...stageableFilePaths], {
      cwd: project.path,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
    });

    const commitSha = execFileSync(getToolPath('git'), ['rev-parse', '--short', 'HEAD'], {
      cwd: project.path,
      encoding: 'utf-8',
      env: getIsolatedGitEnv(),
    }).trim();

    const pushResult = this.pushMergedBaseBranch(project, task, baseBranch);
    if (!pushResult.success) {
      this.persistMergePushFailure(project, task, commitSha, pushResult.message);
      projectStore.invalidateTasksCache(project.id);
      return {
        success: false,
        message: `Merged locally at ${commitSha}, but could not push ${baseBranch}: ${pushResult.message}`,
        commitSha,
      };
    }

    const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
    const planPaths = [
      path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
      path.join(worktreePath, getSpecsDir(project.autoBuildPath), task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    ];
    for (const planPath of planPaths) {
      if (existsSync(planPath)) updatePlanAfterAppMerge(planPath, 'done', 'completed', commitSha);
    }

    const cleanupResult = await cleanupWorktree({
      worktreePath,
      projectPath: project.path,
      specId: task.specId,
      logPrefix: '[AgentManager:auto-merge]',
      deleteBranch: true,
    });
    if (!cleanupResult.success) {
      console.warn(`[AgentManager] Auto-merge committed ${task.specId}, but worktree cleanup reported warnings:`, cleanupResult.warnings);
    }

    projectStore.invalidateTasksCache(project.id);
    return { success: true, message: 'Merged successfully', commitSha };
  }

  private async finalizeAlreadyMergedHumanReviewTask(
    project: Project,
    task: Task,
    worktreePath: string,
    reason: string,
  ): Promise<{ success: boolean; message: string; commitSha?: string } | null> {
    const evidence = this.findExistingMergeEvidenceForTask(project, task);
    if (!evidence) return null;

    const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
    const planPaths = [
      path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
      path.join(worktreePath, getSpecsDir(project.autoBuildPath), task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
    ];
    for (const planPath of planPaths) {
      if (existsSync(planPath)) updatePlanAfterAppMerge(planPath, 'done', 'completed', evidence.commitSha);
    }

    const cleanupResult = await cleanupWorktree({
      worktreePath,
      projectPath: project.path,
      specId: task.specId,
      logPrefix: '[AgentManager:auto-merge]',
      deleteBranch: true,
    });
    if (!cleanupResult.success) {
      console.warn(`[AgentManager] Already-merged cleanup for ${task.specId} reported warnings:`, cleanupResult.warnings);
    }

    projectStore.invalidateTasksCache(project.id);
    return {
      success: true,
      message: `${reason}; existing reachable merge evidence found from ${evidence.source}`,
      commitSha: evidence.commitSha,
    };
  }

  private findExistingMergeEvidenceForTask(project: Project, task: Task): TaskMergeEvidence | null {
    for (const plan of this.readHumanReviewPlanCandidates(project, task)) {
      const evidence = findReachableTaskMergeEvidence({
        projectPath: project.path,
        specId: task.specId,
        plan,
      });
      if (evidence) return evidence;
    }

    return findReachableTaskMergeEvidence({
      projectPath: project.path,
      specId: task.specId,
    });
  }

  private pushMergedBaseBranch(project: Project, task: Task, baseBranch: string): { success: boolean; message: string } {
    const shouldPush = project.settings?.pushNewBranches !== false && task.metadata?.pushNewBranches !== false;
    if (!shouldPush) {
      return { success: true, message: 'remote push disabled' };
    }

    try {
      execFileSync(getToolPath('git'), ['remote', 'get-url', 'origin'], {
        cwd: project.path,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
      });
    } catch {
      return { success: true, message: 'no origin remote configured' };
    }

    const targetBranch = baseBranch.replace(/^origin\//, '');
    try {
      execFileSync(getToolPath('git'), ['push', 'origin', `HEAD:${targetBranch}`], {
        cwd: project.path,
        encoding: 'utf-8',
        env: getIsolatedGitEnv(),
      });
      return { success: true, message: `pushed origin/${targetBranch}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message };
    }
  }

  private persistMergePushFailure(project: Project, task: Task, commitSha: string, message: string): void {
    const now = new Date().toISOString();
    for (const planPath of getPlanPathsForSpec(project, task.specId)) {
      if (!existsSync(planPath)) continue;
      try {
        const plan = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
        if (!plan) continue;
        plan.status = 'human_review';
        plan.planStatus = 'review';
        plan.reviewReason = 'errors';
        plan.xstateState = 'human_review';
        plan.executionPhase = 'complete';
        plan.localMergeCommit = commitSha;
        plan.mergePushError = message;
        plan.updated_at = now;
        plan.lastEvent = {
          eventId: `merge-push-failed-${Date.now()}`,
          sequence: 0,
          type: 'MERGE_PUSH_FAILED',
          timestamp: now,
          data: { commitSha, message },
        };
        writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      } catch (error) {
        console.warn(`[AgentManager] Failed to persist merge push failure for ${task.specId}:`, error);
      }
    }
  }

  /**
   * Kill a specific task's process
   */
  killTask(taskId: string): boolean {
    return this.processManager.killProcess(taskId);
  }

  /**
   * Stop ideation generation for a project
   */
  stopIdeation(projectId: string): boolean {
    return this.queueManager.stopIdeation(projectId);
  }

  /**
   * Check if ideation is running for a project
   */
  isIdeationRunning(projectId: string): boolean {
    return this.queueManager.isIdeationRunning(projectId);
  }

  /**
   * Stop roadmap generation for a project
   */
  stopRoadmap(projectId: string): boolean {
    return this.queueManager.stopRoadmap(projectId);
  }

  /**
   * Check if roadmap is running for a project
   */
  isRoadmapRunning(projectId: string): boolean {
    return this.queueManager.isRoadmapRunning(projectId);
  }

  /**
   * Kill all running processes
   */
  async killAll(): Promise<void> {
    await this.processManager.killAllProcesses();
  }

  /**
   * Check if a task is running
   */
  isRunning(taskId: string): boolean {
    const processInfo = this.state.getProcess(taskId);
    if (!processInfo) return false;
    if (this.isTrackedProcessLive(processInfo)) return true;
    const projectsById = new Map(projectStore.getProjects().map((project) => [project.id, project]));
    this.clearTrackedProcess(taskId, processInfo, projectsById, 'isRunning clearing exited worker handle');
    return false;
  }

  /**
   * Get all running task IDs
   */
  getRunningTasks(): string[] {
    return this.state.getRunningTaskIds().filter((taskId) => this.isRunning(taskId));
  }

  /**
   * Store task execution context for potential restarts
   */
  private storeTaskContext(
    taskId: string,
    projectPath: string,
    specId: string,
    options: TaskExecutionOptions,
    isSpecCreation?: boolean,
    taskDescription?: string,
    specDir?: string,
    metadata?: SpecCreationMetadata,
    baseBranch?: string,
    projectId?: string
  ): void {
    // Preserve swapCount if context already exists (for restarts)
    const existingContext = this.taskExecutionContext.get(taskId);
    const swapCount = existingContext?.swapCount ?? 0;
    // Increment generation on each store (restarts) to invalidate pending cleanup callbacks
    const generation = (existingContext?.generation ?? 0) + 1;

    this.taskExecutionContext.set(taskId, {
      projectPath,
      specId,
      options,
      isSpecCreation,
      taskDescription,
      specDir,
      metadata,
      baseBranch,
      swapCount, // Preserve existing count instead of resetting
      projectId,
      generation, // Incremented to prevent stale exit cleanup
    });
  }

  /**
   * Restart task after profile swap
   * @param taskId - The task to restart
   * @param newProfileId - Optional new profile ID to apply (from auto-swap)
   */
  restartTask(taskId: string, newProfileId?: string): boolean {
    console.log('[AgentManager] restartTask called for:', taskId, 'with newProfileId:', newProfileId);

    const context = this.taskExecutionContext.get(taskId);
    if (!context) {
      console.error('[AgentManager] No context for task:', taskId);
      console.log('[AgentManager] Available task contexts:', Array.from(this.taskExecutionContext.keys()));
      return false;
    }

    console.log('[AgentManager] Task context found:', {
      taskId,
      projectPath: context.projectPath,
      specId: context.specId,
      isSpecCreation: context.isSpecCreation,
      swapCount: context.swapCount
    });

    // Prevent infinite swap loops
    if (context.swapCount >= 2) {
      console.error('[AgentManager] Max swap count reached for task:', taskId, '- stopping restart loop');
      return false;
    }

    context.swapCount++;
    console.log('[AgentManager] Incremented swap count to:', context.swapCount);

    // If a new profile was specified, ensure it's set as active before restart
    if (newProfileId) {
      const profileManager = getClaudeProfileManager();
      const currentActiveId = profileManager.getActiveProfile()?.id;
      if (currentActiveId !== newProfileId) {
        console.log('[AgentManager] Setting active profile to:', newProfileId);
        profileManager.setActiveProfile(newProfileId);
      }
    }

    // Kill current process
    console.log('[AgentManager] Killing current process for task:', taskId);
    this.killTask(taskId);

    // Wait for cleanup, then reset stuck subtasks and restart
    console.log('[AgentManager] Scheduling task restart in 500ms');
    setTimeout(async () => {
      // Reset stuck subtasks before restart to avoid picking up stale in-progress states
      if (context.specId || context.specDir) {
        const planPath = context.specDir
          ? path.join(context.specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN)
          : path.join(context.projectPath, AUTO_BUILD_PATHS.SPECS_DIR, context.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);

        console.log('[AgentManager] Resetting stuck subtasks before restart:', planPath);
        try {
          const { success, resetCount } = await resetStuckSubtasks(planPath);
          if (success && resetCount > 0) {
            console.log(`[AgentManager] Successfully reset ${resetCount} stuck subtask(s)`);
          }
        } catch (err) {
          console.warn('[AgentManager] Failed to reset stuck subtasks:', err);
        }
      }

      console.log('[AgentManager] Restarting task now:', taskId);
      if (context.isSpecCreation) {
        console.log('[AgentManager] Restarting as spec creation');
        if (!context.taskDescription) {
          console.error('[AgentManager] Cannot restart spec creation: taskDescription is missing');
          return;
        }
        this.startSpecCreation(
          taskId,
          context.projectPath,
          context.taskDescription,
          context.specDir,
          context.metadata,
          context.baseBranch,
          context.projectId
        );
      } else {
        console.log('[AgentManager] Restarting as task execution');
        this.startTaskExecution(
          taskId,
          context.projectPath,
          context.specId,
          context.options,
          context.projectId
        );
      }
    }, 500);

    return true;
  }

  // ============================================
  // Queue Routing Methods (Rate Limit Recovery)
  // ============================================

  /**
   * Get running tasks grouped by profile
   * Used by queue routing to determine profile load
   */
  getRunningTasksByProfile(): { byProfile: Record<string, string[]>; totalRunning: number } {
    return this.state.getRunningTasksByProfile();
  }

  /**
   * Assign a profile to a task
   * Records which profile is being used for a task
   */
  assignProfileToTask(
    taskId: string,
    profileId: string,
    profileName: string,
    reason: 'proactive' | 'reactive' | 'manual'
  ): void {
    this.state.assignProfileToTask(taskId, profileId, profileName, reason);
  }

  /**
   * Get the profile assignment for a task
   */
  getTaskProfileAssignment(taskId: string): { profileId: string; profileName: string; reason: string } | undefined {
    return this.state.getTaskProfileAssignment(taskId);
  }

  /**
   * Update the session ID for a task (for session resume)
   */
  updateTaskSession(taskId: string, sessionId: string): void {
    this.state.updateTaskSession(taskId, sessionId);
  }

  /**
   * Get the session ID for a task
   */
  getTaskSessionId(taskId: string): string | undefined {
    return this.state.getTaskSessionId(taskId);
  }

  // ============================================
  // Private helpers for TypeScript agent path
  // ============================================

  /**
   * Serialize a project's SecurityProfile (Sets) into a SerializedSecurityProfile (arrays)
   * for transfer across worker thread boundaries.
   */
  private serializeSecurityProfile(projectDir: string): SerializedSecurityProfile {
    const profile = getSecurityProfile(projectDir);
    return {
      baseCommands: [...profile.baseCommands],
      stackCommands: [...profile.stackCommands],
      scriptCommands: [...profile.scriptCommands],
      customCommands: [...profile.customCommands],
      customScripts: {
        shellScripts: profile.customScripts.shellScripts,
      },
    };
  }

  /**
   * Resolve the model ID for a task by reading task_metadata.json.
   * Falls back to the default sonnet model if metadata is not available.
   *
   * @param specDir - The spec directory path
   * @param phase - The execution phase ('planning', 'coding', 'qa', 'spec')
   */
  private async resolveTaskModelId(specDir: string, phase: 'planning' | 'coding' | 'qa' | 'spec'): Promise<string> {
    try {
      const metadataPath = path.join(specDir, 'task_metadata.json');
      if (existsSync(metadataPath)) {
        const raw = readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(raw) as {
          isAutoProfile?: boolean;
          phaseModels?: Record<string, string>;
          phaseProviders?: Record<string, string>;
          provider?: string;
          model?: string;
        };

        // Determine the target provider for this phase
        const targetProvider = (metadata.phaseProviders?.[phase] ?? metadata.provider ?? null) as BuiltinProvider | null;

        let shorthand: string | undefined;
        if (metadata.phaseModels?.[phase]) {
          shorthand = metadata.phaseModels[phase];
        } else if (metadata.model) {
          shorthand = metadata.model;
        }

        // If shorthand is empty (e.g., Ollama presets use '' because models are dynamic),
        // try reading the user's per-provider phase config from settings
        if (!shorthand && targetProvider) {
          const settings = readSettingsFile();
          const providerPhaseModels = (settings?.providerAgentConfig as Record<string, Record<string, unknown>> | undefined)?.[targetProvider]?.customPhaseModels as Record<string, string> | undefined;
          if (providerPhaseModels?.[phase]) {
            shorthand = providerPhaseModels[phase];
          }
        }

        if (shorthand) {
          // First resolve to a full model ID (handles Anthropic shorthands like 'opus' → 'claude-opus-4-6')
          const baseModelId = resolveModelId(shorthand);

          // If the target provider is non-Anthropic, translate the model ID to the
          // target provider's equivalent. This ensures the queue resolution succeeds
          // when the user has swapped away from Anthropic.
          if (targetProvider && targetProvider !== 'anthropic') {
            const equiv = resolveModelEquivalent(shorthand, targetProvider)
              ?? resolveModelEquivalent(baseModelId, targetProvider);
            if (equiv) {
              return equiv.modelId;
            }
            // If no equivalence found and the model is already a raw model name
            // (e.g., user-configured Ollama model), pass it through unchanged
            return shorthand;
          }

          return baseModelId;
        }

        // Still no model but have a target provider — resolve 'sonnet' equivalent
        if (targetProvider && targetProvider !== 'anthropic') {
          const equiv = resolveModelEquivalent('sonnet', targetProvider);
          if (equiv) return equiv.modelId;
        }
      }
    } catch {
      // Fall through to default
    }

    // Default: resolve 'sonnet' (Anthropic fallback)
    return resolveModelId('sonnet');
  }

  /**
   * Resolve the provider override for a phase from task_metadata.json.
   * Returns null if no per-phase provider is specified (use default queue).
   */
  private resolveTaskPhaseProvider(specDir: string, phase: 'planning' | 'coding' | 'qa' | 'spec'): string | null {
    try {
      const metadataPath = path.join(specDir, 'task_metadata.json');
      if (existsSync(metadataPath)) {
        const raw = readFileSync(metadataPath, 'utf-8');
        const metadata = JSON.parse(raw) as {
          phaseProviders?: Record<string, string>;
          provider?: string;
        };
        // Per-phase provider (cross-provider mode) takes precedence,
        // then fall back to the single task-level provider (e.g. 'ollama')
        return metadata.phaseProviders?.[phase] ?? metadata.provider ?? null;
      }
    } catch {
      // Fall through
    }
    return null;
  }

  /**
   * Load a system prompt from the prompts directory.
   * Returns null if the prompt file is not found.
   *
   * @param promptName - The prompt filename without extension (e.g., 'planner', 'qa_reviewer')
   */
  private loadPrompt(promptName: string): string | null {
    return tryLoadPrompt(promptName);
  }

  /**
   * Build a minimal default system prompt for spec orchestration
   * when the prompt file is not found.
   */
  private buildDefaultSpecPrompt(taskDescription: string, specDir?: string): string {
    return `You are a spec creation agent. Your job is to create a detailed specification and implementation plan for the following task:\n\n${taskDescription}${specDir ? `\n\nSpec directory: ${specDir}` : ''}\n\nCreate a spec.md with requirements and an implementation_plan.json with phases and subtasks.${APERANT_WORKFLOW_GUARD}`;
  }

  /**
   * Build a minimal default system prompt for the planner/build orchestrator
   * when the prompt file is not found.
   */
  private buildDefaultPlannerPrompt(specId: string, projectPath: string): string {
    return `You are a planning agent. Your job is to review the spec and create an implementation plan for spec ${specId} in project ${projectPath}. Read the spec.md and create implementation_plan.json with phases and subtasks.${APERANT_WORKFLOW_GUARD}`;
  }

  /**
   * Build a minimal default system prompt for the QA reviewer
   * when the prompt file is not found.
   */
  private buildDefaultQAPrompt(specId: string, projectPath: string): string {
    return `You are a QA reviewer agent. Your job is to review the implementation of spec ${specId} in project ${projectPath}. Check that all requirements in spec.md are implemented correctly, write qa_report.md with Status: PASSED or Status: FAILED, and update implementation_plan.json with qa_signoff.status set to "approved" or "rejected".${APERANT_WORKFLOW_GUARD}`;
  }

  /**
   * Build initial messages for task execution (build_orchestrator).
   * Includes the spec.md and implementation_plan.json content for agent context.
   */
  private buildTaskExecutionMessages(
    specDir: string,
    specId: string,
    projectPath: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const parts: string[] = [];

    parts.push(`You are implementing spec ${specId} in project: ${projectPath}`);
    parts.push(`Spec directory: ${specDir}`);
    parts.push('');

    // Read spec.md
    const specPath = path.join(specDir, 'spec.md');
    try {
      if (existsSync(specPath)) {
        const specContent = readFileSync(specPath, 'utf-8');
        parts.push('## Specification (spec.md)');
        parts.push('');
        parts.push(specContent);
        parts.push('');
      }
    } catch {
      // Not critical — agent can read spec itself
    }

    const baseSyncConflictPath = path.join(specDir, 'BASE_SYNC_CONFLICT.md');
    try {
      if (existsSync(baseSyncConflictPath)) {
        parts.push('## Base Branch Sync Conflict');
        parts.push('');
        parts.push(readFileSync(baseSyncConflictPath, 'utf-8'));
        parts.push('');
      }
    } catch {
      // Not critical — recovery subtask still carries the conflict list.
    }

    // Read implementation_plan.json if it exists (resume scenario)
    const planPath = path.join(specDir, 'implementation_plan.json');
    try {
      if (existsSync(planPath)) {
        const planContent = readFileSync(planPath, 'utf-8');
        parts.push('## Implementation Plan (implementation_plan.json)');
        parts.push('');
        parts.push('```json');
        parts.push(planContent);
        parts.push('```');
	        parts.push('');
	        parts.push('Resume implementing the pending/in-progress subtasks. Do NOT redo completed subtasks. Update each subtask status to "completed" in implementation_plan.json after finishing it.');
	        parts.push(APERANT_WORKFLOW_GUARD);
	      } else {
	        parts.push('No implementation plan exists yet. Start by creating implementation_plan.json with phases and subtasks, then implement each subtask.');
	        parts.push(APERANT_WORKFLOW_GUARD);
	      }
    } catch {
      // Fall through
    }

    return [{ role: 'user', content: parts.join('\n') }];
  }

  /**
   * Build initial messages for QA process.
   * Includes spec.md and implementation plan to give QA agent full context.
   */
  private buildQAInitialMessages(
    specDir: string,
    specId: string,
    projectPath: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const parts: string[] = [];

    parts.push(`You are reviewing the implementation of spec ${specId} in project: ${projectPath}`);
    parts.push(`Spec directory: ${specDir}`);
    parts.push('');

    // Read spec.md
    const specPath = path.join(specDir, 'spec.md');
    try {
      if (existsSync(specPath)) {
        const specContent = readFileSync(specPath, 'utf-8');
        parts.push('## Specification (spec.md)');
        parts.push('');
        parts.push(specContent);
        parts.push('');
      }
    } catch {
      // Not critical
    }

    // Read implementation_plan.json to show what was planned/completed
    const planPath = path.join(specDir, 'implementation_plan.json');
    try {
      if (existsSync(planPath)) {
        const planContent = readFileSync(planPath, 'utf-8');
        parts.push('## Implementation Plan (implementation_plan.json)');
        parts.push('');
        parts.push('```json');
        parts.push(planContent);
        parts.push('```');
        parts.push('');
      }
    } catch {
      // Fall through
    }

    parts.push('Review the implementation against the specification. Check that all requirements are met, the code is correct, and tests pass. Write your findings to qa_report.md with "Status: PASSED" or "Status: FAILED" and a list of any issues found.');
    parts.push('Also update implementation_plan.json with a qa_signoff object: use {"status":"approved","issues_found":[]} when passing, or {"status":"rejected","issues_found":[...]} when failing. The app uses this field for workflow routing.');
    parts.push(APERANT_WORKFLOW_GUARD);

    return [{ role: 'user', content: parts.join('\n') }];
  }
}
