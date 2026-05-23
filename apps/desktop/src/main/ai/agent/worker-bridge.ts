/**
 * Worker Bridge
 * =============
 *
 * Main-thread bridge that spawns a Worker thread and relays `postMessage()`
 * events to an EventEmitter matching the `AgentManagerEvents` interface.
 *
 * This allows the existing agent management system (agent-process.ts,
 * agent-events.ts) to consume worker thread events transparently — the UI
 * cannot distinguish between a Python subprocess and a TS worker thread.
 */

import { Worker } from 'worker_threads';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { app } from 'electron';

import type { AgentManagerEvents, ExecutionProgressData, ProcessType } from '../../agent/types';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import type {
  WorkerConfig,
  WorkerMessage,
  AgentExecutorConfig,
} from './types';
import type { SessionResult } from '../session/types';
import { ProgressTracker } from '../session/progress-tracker';

const WORKER_OLD_GENERATION_LIMIT_MB = 384;
const WORKER_YOUNG_GENERATION_LIMIT_MB = 64;
const CHILD_WORKER_SHUTDOWN_TIMEOUT_MS = 2_000;

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Worker Path Resolution
// =============================================================================

/**
 * Resolve the path to the worker entry point.
 * Handles both dev (source via electron-vite) and production (bundled) paths.
 */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    // Production: worker is inside app.asar at out/main/ai/agent/worker.js
    return path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'ai', 'agent', 'worker.js');
  }
  // Dev: electron-vite outputs worker at out/main/ai/agent/worker.js
  // because the Rollup input key is 'ai/agent/worker'.
  // __dirname resolves to out/main/ at runtime, so we need the subdirectory.
  return path.join(__dirname, 'ai', 'agent', 'worker.js');
}

function formatWorkerError(error: Error): string {
  const code = (error as Error & { code?: string }).code ?? '';
  const rawMessage = error.message || String(error);
  const isOutOfMemory = code === 'ERR_WORKER_OUT_OF_MEMORY'
    || /out of memory|heap limit|heap out of memory|allocation failed/i.test(rawMessage);

  if (!isOutOfMemory) return rawMessage;

  return `Worker exceeded memory limit (${WORKER_OLD_GENERATION_LIMIT_MB}MB old generation). ` +
    'The task worker was stopped so Aperant can recover instead of crashing.';
}

type AgentWorkerHandle = Worker | ChildProcess;

function useThreadWorkerForCurrentProcess(): boolean {
  if (process.env.APERANT_AGENT_WORKER_MODE === 'thread') return true;
  if (process.env.APERANT_AGENT_WORKER_MODE === 'process') return false;
  return process.env.NODE_ENV === 'test';
}

function isThreadWorker(worker: AgentWorkerHandle): worker is Worker {
  return typeof (worker as Worker).terminate === 'function';
}

// =============================================================================
// WorkerBridge
// =============================================================================

/**
 * Bridges a worker thread to the AgentManagerEvents interface.
 *
 * Usage:
 * ```ts
 * const bridge = new WorkerBridge();
 * bridge.on('log', (taskId, log) => { ... });
 * bridge.on('exit', (taskId, code, processType) => { ... });
 * await bridge.spawn(config);
 * ```
 */
export class WorkerBridge extends EventEmitter {
  private worker: AgentWorkerHandle | null = null;
  private progressTracker: ProgressTracker = new ProgressTracker();
  private taskId: string = '';
  private projectId: string | undefined;
  private processType: ProcessType = 'task-execution';

  /**
   * Spawn a worker thread with the given configuration.
   * The worker will immediately begin executing the agent session.
   *
   * @param config - Executor configuration (task ID, session params, etc.)
   */
  spawn(config: AgentExecutorConfig): void {
    if (this.worker) {
      throw new Error('WorkerBridge already has an active worker. Call terminate() first.');
    }

    this.taskId = config.taskId;
    this.projectId = config.projectId;
    this.processType = config.processType;
    this.progressTracker = new ProgressTracker();

    const workerConfig: WorkerConfig = {
      taskId: config.taskId,
      projectId: config.projectId,
      processType: config.processType,
      session: config.session,
    };

    const workerPath = resolveWorkerPath();

    if (useThreadWorkerForCurrentProcess()) {
      this.spawnThreadWorker(workerPath, workerConfig);
    } else {
      this.spawnChildProcessWorker(workerPath, workerConfig);
    }
  }

  private spawnThreadWorker(workerPath: string, workerConfig: WorkerConfig): void {
    const worker = new Worker(workerPath, {
      workerData: workerConfig,
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_OLD_GENERATION_LIMIT_MB,
        maxYoungGenerationSizeMb: WORKER_YOUNG_GENERATION_LIMIT_MB,
      },
    });

    this.worker = worker;

    worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    worker.on('error', (error: Error) => {
      if (!this.worker) return;
      this.emitTyped('error', this.taskId, formatWorkerError(error), this.projectId);
      this.emitTyped('exit', this.taskId, 1, this.processType, this.projectId);
      this.cleanup();
    });

    worker.on('exit', (code: number) => {
      // Code 0 = clean exit; non-zero = crash/error
      // Only emit exit if we haven't already emitted from a 'result' message
      if (this.worker) {
        this.emitTyped('exit', this.taskId, code === 0 ? 0 : code, this.processType, this.projectId);
        this.cleanup();
      }
    });
  }

  private spawnChildProcessWorker(workerPath: string, workerConfig: WorkerConfig): void {
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        APERANT_AGENT_WORKER_CONFIG: JSON.stringify(workerConfig),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    this.worker = child;

    child.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(message);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.emitTyped('log', this.taskId, text, this.projectId);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.emitTyped('log', this.taskId, `[agent stderr] ${text}`, this.projectId);
    });

    child.on('error', (error: Error) => {
      if (!this.worker) return;
      this.emitTyped('error', this.taskId, error.message, this.projectId);
      this.emitTyped('exit', this.taskId, 1, this.processType, this.projectId);
      this.cleanup();
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Only emit exit if we haven't already emitted from a 'result' message.
      if (!this.worker) return;
      const exitCode = code ?? (signal ? 1 : 0);
      if (signal && exitCode !== 0) {
        this.emitTyped('error', this.taskId, `Agent worker exited from signal ${signal}`, this.projectId);
      }
      this.emitTyped('exit', this.taskId, exitCode, this.processType, this.projectId);
      this.cleanup();
    });
  }

  /**
   * Terminate the worker thread.
   * Sends an abort message first for graceful shutdown, then terminates.
   */
  async terminate(): Promise<void> {
    if (!this.worker) return;

    const worker = this.worker;

    // Try graceful abort first
    try {
      if (isThreadWorker(worker)) {
        worker.postMessage({ type: 'abort' });
      } else if (worker.connected) {
        worker.send({ type: 'abort' });
      }
    } catch {
      // Worker may already be dead
    }

    this.cleanup();

    if (isThreadWorker(worker)) {
      try {
        await worker.terminate();
      } catch {
        // Already terminated
      }
      return;
    }

    await new Promise<void>((resolve) => {
      if (worker.exitCode !== null || worker.signalCode !== null) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try {
          worker.kill('SIGKILL');
        } catch {
          // Already terminated
        }
        resolve();
      }, CHILD_WORKER_SHUTDOWN_TIMEOUT_MS);

      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        worker.kill('SIGTERM');
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /** Whether the worker is currently active */
  get isActive(): boolean {
    return this.worker !== null;
  }

  /** Get the underlying Worker instance (for advanced use) */
  get workerInstance(): Worker | ChildProcess | null {
    return this.worker;
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleWorkerMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'log':
        this.emitTyped('log', message.taskId, message.data, message.projectId);
        break;

      case 'error':
        this.emitTyped('error', message.taskId, message.data, message.projectId);
        break;

      case 'execution-progress':
        this.emitTyped('execution-progress', message.taskId, message.data, message.projectId);
        break;

      case 'stream-event':
        // Feed the progress tracker and emit progress updates
        this.progressTracker.processEvent(message.data);
        this.emitProgressFromTracker(message.taskId, message.projectId);
        // Also forward raw log for text events
        if (message.data.type === 'text-delta') {
          this.emitTyped('log', message.taskId, message.data.text, message.projectId);
        }
        break;

      case 'task-event':
        this.emitTyped('task-event', message.taskId, message.data as TaskEventPayload, message.projectId);
        break;

      case 'result':
        this.handleResult(message.taskId, message.data, message.projectId);
        break;
    }
  }

  /**
   * Convert ProgressTracker state into an ExecutionProgressData event
   * and emit it to listeners.
   */
  private emitProgressFromTracker(taskId: string, projectId?: string): void {
    const state = this.progressTracker.state;
    const progressData: ExecutionProgressData = {
      phase: state.currentPhase,
      phaseProgress: 0, // Detailed progress calculated by UI from phase
      overallProgress: 0,
      currentSubtask: state.currentSubtask ?? undefined,
      message: state.currentMessage,
      completedPhases: state.completedPhases as ExecutionProgressData['completedPhases'],
    };
    this.emitTyped('execution-progress', taskId, progressData, projectId);
  }

  /**
   * Handle the final session result from the worker.
   * Maps SessionResult.outcome to an exit code.
   */
  private handleResult(taskId: string, result: SessionResult, projectId?: string): void {
    // Map outcome to exit code
    const exitCode = result.outcome === 'completed' || result.outcome === 'max_steps' || result.outcome === 'context_window' ? 0 : 1;

    // Log the result summary
    const summary = `Session complete: outcome=${result.outcome}, steps=${result.stepsExecuted}, tools=${result.toolCallCount}, duration=${result.durationMs}ms`;
    this.emitTyped('log', taskId, summary, projectId);

    if (result.error) {
      this.emitTyped('error', taskId, result.error.message, projectId);
    }

    // Emit exit and cleanup
    this.emitTyped('exit', taskId, exitCode, this.processType, projectId);
    this.cleanup();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Type-safe emit that matches AgentManagerEvents signatures.
   */
  private emitTyped<K extends keyof AgentManagerEvents>(
    event: K,
    ...args: Parameters<AgentManagerEvents[K]>
  ): void {
    this.emit(event, ...args);
  }

  private cleanup(): void {
    this.worker = null;
  }
}
