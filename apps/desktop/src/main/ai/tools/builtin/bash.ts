/**
 * Bash Command Tool
 * =================
 *
 * Executes bash commands with security validation.
 * Integrates with bashSecurityHook() for pre-execution command allowlisting.
 * Supports timeouts, background execution, and descriptive metadata.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod/v3';

import { getAugmentedEnv } from '../../../env-utils';
import { findExecutable, isWindows } from '../../../platform/index';
import { bashSecurityHook } from '../../security/bash-validator';
import { Tool } from '../define';
import { ToolPermission } from '../types';
import {
  registerActiveCommand,
  terminateProcessGroupByPid,
  unregisterActiveCommand,
} from './bash-process-tracker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ROUTE_SMOKE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_LENGTH = 30_000;

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z
    .number()
    .optional()
    .describe('Optional timeout in milliseconds (max 600000)'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Set to true to run this command in the background'),
  description: z
    .string()
    .optional()
    .describe('Clear, concise description of what this command does'),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[Output truncated — ${output.length} characters total]`;
}

function resolveShell(): string {
  if (isWindows()) {
    // Prefer Git Bash on Windows; fall back to cmd.exe
    return findExecutable('bash') ?? (process.env.ComSpec || 'cmd.exe');
  }
  return '/bin/bash';
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;

  terminateProcessGroupByPid(pid, signal);
}

function buildImmediateCommandGuidance(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const runsPlaywrightWrapper = /\bpnpm\b.*\btest:e2e\b/.test(normalized);
  const runsPlaywrightTest = isPlaywrightTestCommand(normalized);
  const runsConsoleRouteSmoke = isConsoleRouteSmokeCommand(normalized);
  const runsLikelySilentPlaywrightLine = runsPlaywrightTest
    && /--reporter(?:=|\s+)line\b/.test(normalized);
  const runsLikelySilentRouteSmoke = runsConsoleRouteSmoke
    && !/\bDEBUG=/.test(normalized);
  const runsRouteSmokeWithoutTestTimeout = runsConsoleRouteSmoke
    && !/--timeout(?:=|\s+)\d+\b/.test(normalized);
  const runsRouteSmokeWithoutExplicitPort = runsConsoleRouteSmoke
    && !/\bLAYER1_CONSOLE_E2E_PORT=/.test(normalized);
  const runsRouteSmokeOnDefaultPort = runsConsoleRouteSmoke
    && /\bLAYER1_CONSOLE_E2E_PORT=(?:["']?)3124(?:["']?)\b/.test(normalized);
  const alreadyVerbose = /--reporter(?:=|\s+)(list|github|json)\b/.test(normalized)
    || /\bDEBUG=/.test(normalized)
    || /\bPWDEBUG=/.test(normalized);

  if (
    (!runsPlaywrightWrapper
      && !runsLikelySilentPlaywrightLine
      && !runsLikelySilentRouteSmoke
      && !runsRouteSmokeWithoutTestTimeout
      && !runsRouteSmokeWithoutExplicitPort
      && !runsRouteSmokeOnDefaultPort)
    || (alreadyVerbose
      && !runsLikelySilentRouteSmoke
      && !runsRouteSmokeWithoutTestTimeout
      && !runsRouteSmokeWithoutExplicitPort
      && !runsRouteSmokeOnDefaultPort)
  ) {
    return null;
  }

  const suggestedCommand = normalized.includes('console-routes')
    ? 'DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000)) LAYER1_CONSOLE_DATA_MODE=fixture LAYER1_CONSOLE_AUTH_DISABLED=true pnpm --filter @yect/layer1-console exec playwright test tests/e2e/console-routes.spec.ts --project=desktop --reporter=list --workers=1 --timeout=30000'
    : 'pnpm exec playwright test --reporter=list --workers=1';

  return (
    `Error: Command is likely to run silently until Aperant's foreground idle watchdog kills it: ${command}\n` +
    `Use a verbose or narrower Playwright invocation instead, for example:\n` +
    `${suggestedCommand}\n` +
    `Do not rerun the same command unchanged.`
  );
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function isPlaywrightTestCommand(normalizedCommand: string): boolean {
  return /\bplaywright\s+test\b/.test(normalizedCommand);
}

function isConsoleRouteSmokeCommand(normalizedCommand: string): boolean {
  return isPlaywrightTestCommand(normalizedCommand)
    && /\bconsole-routes\.spec\.ts\b/.test(normalizedCommand);
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  cleanupProcessGroup = true,
  tracking?: { specDir?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; idleTimedOut: boolean; aborted: boolean }> {
  const shell = resolveShell();
  const args = isWindows() && shell.toLowerCase().endsWith('cmd.exe')
    ? ['/c', command]
    : ['-c', command];

  return new Promise((resolve) => {
    let timedOut = false;
    let idleTimedOut = false;
    let aborted = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let trackingReady: Promise<void> = Promise.resolve();

    let child: ChildProcess | null = null;
    child = spawn(
      shell,
      args,
      {
        cwd,
        detached: !isWindows(),
        env: getAugmentedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const childPid = child.pid;
    const shouldTrack = Boolean(tracking?.specDir && childPid && cleanupProcessGroup);

    if (shouldTrack && tracking?.specDir && childPid) {
      trackingReady = registerActiveCommand(tracking.specDir, {
        pid: childPid,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        foreground: true,
      }).catch(() => {
        // Tracking is best-effort; command execution must continue.
      });
    }

    const resetIdleTimer = () => {
      if (!cleanupProcessGroup || timeoutMs <= DEFAULT_IDLE_TIMEOUT_MS) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate('idle-timeout'), DEFAULT_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      resetIdleTimer();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      resetIdleTimer();
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', onAbort);

      // Clean up leaked descendants from commands that spawn dev servers,
      // watchers, or Playwright webServer children and then exit/fail.
      if (cleanupProcessGroup && child) {
        terminateProcessTree(child, 'SIGTERM');
      }

      trackingReady
        .then(async () => {
          if (shouldTrack && tracking?.specDir && childPid) {
            await unregisterActiveCommand(tracking.specDir, childPid);
          }
        })
        .catch(() => {
          // Non-fatal cleanup; stale markers are handled before the next attempt.
        })
        .finally(() => {
          resolve({
            stdout,
            stderr,
            exitCode: timedOut || idleTimedOut ? 124 : aborted ? 130 : exitCode,
            timedOut,
            idleTimedOut,
            aborted,
          });
        });
    };

    child.on('error', () => finish(1));
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));

    const forceKill = () => {
      forceKillTimer = setTimeout(() => {
        if (child) {
          terminateProcessTree(child, 'SIGKILL');
        }
      }, 5_000);
      forceKillTimer.unref?.();
    };

    const terminate = (reason: 'timeout' | 'idle-timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'idle-timeout') idleTimedOut = true;
      if (reason === 'abort') aborted = true;
      if (child) {
        terminateProcessTree(child, 'SIGTERM');
      }
      forceKill();
    };

    function onAbort(): void {
      terminate('abort');
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);
      timeoutTimer.unref?.();
      resetIdleTimer();
    }

    if (abortSignal?.aborted) {
      terminate('abort');
    } else if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const bashTool = Tool.define({
  metadata: {
    name: 'Bash',
    description:
      'Executes a given bash command with optional timeout. Use for git operations, command execution, and other terminal tasks.',
    permission: ToolPermission.RequiresApproval,
    executionOptions: {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowBackground: true,
    },
  },
  inputSchema,
  execute: async (input, context) => {
    const { command, timeout, run_in_background } = input;

    // Security: validate command against security profile via bashSecurityHook
    const hookResult = bashSecurityHook(
      {
        toolName: 'Bash',
        toolInput: { command },
        cwd: context.cwd,
      },
      context.securityProfile,
    );

    if ('hookSpecificOutput' in hookResult) {
      const reason = hookResult.hookSpecificOutput.permissionDecisionReason;
      return `Error: Command not allowed — ${reason}`;
    }

    const normalizedCommand = normalizeCommand(command);
    const timeoutCapMs = isConsoleRouteSmokeCommand(normalizedCommand)
      ? MAX_ROUTE_SMOKE_TIMEOUT_MS
      : MAX_TIMEOUT_MS;
    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, timeoutCapMs);

    if (run_in_background) {
      // Fire-and-forget for background commands
      executeCommand(command, context.cwd, timeoutMs, context.abortSignal, false);
      return `Command started in background: ${command}`;
    }

    const immediateGuidance = buildImmediateCommandGuidance(command);
    if (immediateGuidance) {
      return immediateGuidance;
    }

    const { stdout, stderr, exitCode, timedOut, idleTimedOut, aborted } = await executeCommand(
      command,
      context.cwd,
      timeoutMs,
      context.abortSignal,
      true,
      { specDir: context.specDir },
    );

    const parts: string[] = [];

    if (stdout) {
      parts.push(truncateOutput(stdout));
    }

    if (stderr) {
      parts.push(`STDERR:\n${truncateOutput(stderr)}`);
    }

    if (exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`);
    }

    if (timedOut) {
      parts.push(`Command timed out after ${timeoutMs}ms; process tree was terminated.`);
    }

    if (idleTimedOut) {
      parts.push(`Command produced no output for ${DEFAULT_IDLE_TIMEOUT_MS}ms and was terminated to keep the worker moving.`);
    }

    if (aborted) {
      parts.push('Command aborted; process tree was terminated.');
    }

    return parts.length > 0 ? parts.join('\n') : '(no output)';
  },
});
