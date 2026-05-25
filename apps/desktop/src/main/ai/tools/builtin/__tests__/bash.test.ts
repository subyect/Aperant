import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bashTool } from '../bash';
import { cleanupStaleForegroundCommands } from '../bash-process-tracker';
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockGetAugmentedEnv = vi.fn(() => ({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }));
vi.mock('../../../../env-utils', () => ({
  getAugmentedEnv: () => mockGetAugmentedEnv(),
}));

const mockIsWindows = vi.fn(() => false);
const mockFindExecutable = vi.fn(() => null);

vi.mock('../../../../platform/index', () => ({
  isWindows: () => mockIsWindows(),
  findExecutable: (_name: string, _additionalPaths?: string[]) => mockFindExecutable(),
}));

const mockBashSecurityHook = vi.fn(() => ({}));
vi.mock('../../../security/bash-validator', () => ({
  bashSecurityHook: (_input: unknown, _profile?: unknown) => mockBashSecurityHook(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext: ToolContext = {
  cwd: '/test/project',
  projectDir: '/test/project',
  specDir: '/test/specs/001',
  securityProfile: {
    baseCommands: new Set(),
    stackCommands: new Set(),
    scriptCommands: new Set(),
    customCommands: new Set(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set(),
  },
} as unknown as ToolContext;

/**
 * Set up mockSpawn to emit stdout/stderr and then close.
 */
function setupSpawn(stdout: string, stderr: string, exitCode: number) {
  mockSpawn.mockImplementation(
    () => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 1234;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => true);
      queueMicrotask(() => {
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', exitCode);
      });
      return child;
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bash Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(false);
    mockBashSecurityHook.mockReturnValue({});
  });

  it('should have correct metadata', () => {
    expect(bashTool.metadata.name).toBe('Bash');
    expect(bashTool.metadata.permission).toBe('requires_approval');
  });

  it('should return stdout from successful command', async () => {
    setupSpawn('hello from bash\n', '', 0);

    const result = await bashTool.config.execute(
      { command: 'echo hello from bash' },
      baseContext,
    );

    expect(result).toContain('hello from bash');
  });

  it('should include stderr in output when present', async () => {
    setupSpawn('', 'some warning\n', 0);

    const result = await bashTool.config.execute(
      { command: 'cmd-with-stderr' },
      baseContext,
    );

    expect(result).toContain('STDERR:');
    expect(result).toContain('some warning');
  });

  it('should include exit code in output when non-zero', async () => {
    setupSpawn('', '', 1);

    const result = await bashTool.config.execute(
      { command: 'failing-command' },
      baseContext,
    );

    expect(result).toContain('Exit code: 1');
  });

  it('should return (no output) when stdout and stderr are empty and exit code is 0', async () => {
    setupSpawn('', '', 0);

    const result = await bashTool.config.execute(
      { command: 'silent-command' },
      baseContext,
    );

    expect(result).toBe('(no output)');
  });

  it('rejects likely silent Playwright wrapper commands with a verbose replacement', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && pnpm test:e2e -- --grep "console-routes"' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000)) LAYER1_CONSOLE_DATA_MODE=fixture LAYER1_CONSOLE_AUTH_DISABLED=true pnpm --filter @yect/layer1-console exec playwright test tests/e2e/console-routes.spec.ts --project=desktop --reporter=list --workers=1 --timeout=30000');
    expect(result).toContain('Do not rerun the same command unchanged');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects Playwright line reporter commands with a list reporter replacement', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=line' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('--reporter=list --workers=1');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects route smoke Playwright commands without webserver debug output', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('DEBUG=pw:webserver');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects route smoke Playwright commands without a test timeout', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && DEBUG=pw:webserver pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('--timeout=30000');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects pnpm Playwright commands with package flags before exec', async () => {
    const result = await bashTool.config.execute(
      { command: 'pwd && ls packages/layer1-console/src/lib/data && pnpm --dir packages/layer1-console exec playwright test tests/e2e/console-routes.spec.ts --reporter=line --workers=1' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('--reporter=list --workers=1 --timeout=30000');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects route smoke Playwright commands without an explicit non-default port', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && DEBUG=pw:webserver pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1 --timeout=30000' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000))');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects route smoke Playwright commands that force the default port', async () => {
    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=3124 pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1 --timeout=30000' },
      baseContext,
    );

    expect(result).toContain('Command is likely to run silently');
    expect(result).toContain('LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000))');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('allows verbose Playwright list reporter commands through the idle watchdog guard', async () => {
    setupSpawn('running with line reporter\n', '', 0);

    const result = await bashTool.config.execute(
      { command: 'cd packages/layer1-console && DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=3134 pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1 --timeout=30000' },
      baseContext,
    );

    expect(result).toContain('running with line reporter');
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('should truncate output exceeding MAX_OUTPUT_LENGTH', async () => {
    const longOutput = 'x'.repeat(31_000);
    setupSpawn(longOutput, '', 0);

    const result = await bashTool.config.execute(
      { command: 'long-output-cmd' },
      baseContext,
    );

    expect(result).toContain('[Output truncated');
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it('should return error message when security hook rejects command', async () => {
    mockBashSecurityHook.mockReturnValue({
      hookSpecificOutput: {
        permissionDecisionReason: 'command is blocked for safety',
      },
    });

    const result = await bashTool.config.execute(
      { command: 'rm -rf /' },
      baseContext,
    );

    expect(result).toContain('Error: Command not allowed');
    expect(result).toContain('command is blocked for safety');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should start command in background and return immediately', async () => {
    // In background mode the execute call is fire-and-forget, so mockSpawn
    // may or may not be called synchronously. The return value is what matters.
    mockSpawn.mockImplementation(
      () => {
        const child = new EventEmitter() as EventEmitter & {
          pid: number;
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.pid = 5678;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => true);
        return child;
      },
    );

    const result = await bashTool.config.execute(
      { command: 'sleep 100', run_in_background: true },
      baseContext,
    );

    expect(result).toContain('Command started in background');
    expect(result).toContain('sleep 100');
  });

  it('should pass cwd from context to spawn', async () => {
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'pwd' },
      baseContext,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/test/project' }),
    );
  });

  it('should pass augmented environment to spawned commands so GUI app launches can find package managers', async () => {
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'pnpm --version' },
      baseContext,
    );

    expect(mockGetAugmentedEnv).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ PATH: expect.stringContaining('/opt/homebrew/bin') }),
      }),
    );
  });

  it('should run foreground commands in a process group and clean descendants on completion', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'pnpm exec playwright test --reporter=list' },
      baseContext,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('removes foreground command tracking when the command finishes', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'aperant-bash-track-finish-'));
    setupSpawn('output', '', 0);

    try {
      await bashTool.config.execute(
        { command: 'pnpm test' },
        { ...baseContext, specDir },
      );

      await expect(readFile(join(specDir, '.aperant-active-commands.json'), 'utf-8'))
        .rejects.toThrow();
    } finally {
      await rm(specDir, { recursive: true, force: true });
    }
  });

  it('should cap timeout to MAX_TIMEOUT_MS (600000)', async () => {
    setupSpawn('output', '', 0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await bashTool.config.execute(
      { command: 'cmd', timeout: 9_000_000 },
      baseContext,
    );

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 600_000);
    setTimeoutSpy.mockRestore();
  });

  it('caps route smoke command timeout even when the agent requests a longer timeout', async () => {
    setupSpawn('output', '', 0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await bashTool.config.execute(
      {
        command: 'cd packages/layer1-console && DEBUG=pw:webserver LAYER1_CONSOLE_E2E_PORT=3134 pnpm exec playwright test tests/e2e/console-routes.spec.ts --reporter=list --workers=1 --timeout=30000',
        timeout: 600_000,
      },
      baseContext,
    );

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000);
    setTimeoutSpy.mockRestore();
  });

  it('terminates long foreground commands that stop producing output', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let child: (EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    }) | null = null;

    mockSpawn.mockImplementation(
      () => {
        child = new EventEmitter() as typeof child;
        child!.pid = 1234;
        child!.stdout = new EventEmitter();
        child!.stderr = new EventEmitter();
        child!.kill = vi.fn(() => true);
        return child;
      },
    );

    try {
      const resultPromise = bashTool.config.execute(
        { command: 'long-running-command', timeout: 600_000 },
        baseContext,
      );

      await vi.advanceTimersByTimeAsync(180_000);

      expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');

      child!.emit('close', null);
      const result = await resultPromise;

      expect(result).toContain('Command produced no output for 180000ms');
      expect(result).toContain('Exit code: 124');
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should use /bin/bash as shell on non-Windows', async () => {
    mockIsWindows.mockReturnValue(false);
    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'echo hi' },
      baseContext,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', 'echo hi'],
      expect.any(Object),
    );
  });

  it('should use cmd.exe args (/c) on Windows when bash not found', async () => {
    // The Windows branch uses /c rather than -c for cmd.exe.
    // We verify the logic by checking that bash uses -c on non-Windows (already tested
    // above) and that the findExecutable mock would select the right executable.
    // This test validates the cmd.exe ComSpec fallback resolution path.
    mockIsWindows.mockReturnValue(true);
    mockFindExecutable.mockReturnValue(null);

    const origComSpec = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    setupSpawn('output', '', 0);

    await bashTool.config.execute(
      { command: 'dir' },
      baseContext,
    );

    // Verify that on Windows with no bash found, cmd.exe with /c flag is used
    const callArgs = mockSpawn.mock.calls[0];
    const shell = callArgs[0] as string;
    const args = callArgs[1] as string[];

    // The shell should be cmd.exe (via ComSpec) and arg should be /c
    expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(args[0]).toBe('/c');
    expect(args[1]).toBe('dir');

    process.env.ComSpec = origComSpec;
  });

  it('cleans stale foreground command groups recorded for a spec', async () => {
    const specDir = await mkdtemp(join(tmpdir(), 'aperant-bash-processes-'));
    const activeCommandsPath = join(specDir, '.aperant-active-commands.json');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await writeFile(activeCommandsPath, JSON.stringify([
      {
        pid: 4321,
        command: 'pnpm test:e2e',
        cwd: '/test/project',
        startedAt: new Date().toISOString(),
        foreground: true,
      },
      {
        pid: 9876,
        command: 'pnpm dev',
        cwd: '/test/project',
        startedAt: new Date().toISOString(),
        foreground: false,
      },
    ], null, 2));

    try {
      const killed = await cleanupStaleForegroundCommands(specDir);
      const remaining = JSON.parse(await readFile(activeCommandsPath, 'utf-8')) as Array<{ pid: number }>;

      expect(killed).toBe(1);
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-9876, 'SIGTERM');
      expect(remaining).toEqual([expect.objectContaining({ pid: 9876 })]);
    } finally {
      killSpy.mockRestore();
      await rm(specDir, { recursive: true, force: true });
    }
  });
});
