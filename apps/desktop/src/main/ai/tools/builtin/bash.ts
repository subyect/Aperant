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

import { findExecutable, isWindows, killProcessGracefully } from '../../../platform/index';
import { bashSecurityHook } from '../../security/bash-validator';
import { Tool } from '../define';
import { ToolPermission } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
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

  if (!isWindows()) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct child kill when the process group is already gone.
    }
  }

  try {
    if (isWindows()) {
      killProcessGracefully(child);
    } else {
      child.kill(signal);
    }
  } catch {
    // Process already exited; nothing to clean up.
  }
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  cleanupProcessGroup = true,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean }> {
  const shell = resolveShell();
  const args = isWindows() && shell.toLowerCase().endsWith('cmd.exe')
    ? ['/c', command]
    : ['-c', command];

  return new Promise((resolve) => {
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    let child: ChildProcess | null = null;
    child = spawn(
      shell,
      args,
      {
        cwd,
        detached: !isWindows(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      abortSignal?.removeEventListener('abort', onAbort);

      // Clean up leaked descendants from commands that spawn dev servers,
      // watchers, or Playwright webServer children and then exit/fail.
      if (cleanupProcessGroup && child) {
        terminateProcessTree(child, 'SIGTERM');
      }

      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : aborted ? 130 : exitCode,
        timedOut,
        aborted,
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

    const terminate = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
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

    const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    if (run_in_background) {
      // Fire-and-forget for background commands
      executeCommand(command, context.cwd, timeoutMs, context.abortSignal, false);
      return `Command started in background: ${command}`;
    }

    const { stdout, stderr, exitCode, timedOut, aborted } = await executeCommand(
      command,
      context.cwd,
      timeoutMs,
      context.abortSignal,
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

    if (aborted) {
      parts.push('Command aborted; process tree was terminated.');
    }

    return parts.length > 0 ? parts.join('\n') : '(no output)';
  },
});
