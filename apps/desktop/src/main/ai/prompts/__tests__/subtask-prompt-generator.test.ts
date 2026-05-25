import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { generateSubtaskPrompt } from '../subtask-prompt-generator';

describe('generateSubtaskPrompt', () => {
  it('carries retry context and tells the coder to finish autonomously', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-project-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');
    await writeFile(join(projectDir, 'example.ts'), 'export const value = 1;\n');

    try {
      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        attemptCount: 1,
        subtask: {
          id: '2.1',
          description: 'Implement the server-side query path.',
          phaseName: 'Backend',
          filesToModify: ['example.ts'],
          status: 'pending',
          lastError: 'Agent session ended without marking the subtask completed.',
          lastAttemptOutcome: 'completed',
        },
      });

      expect(prompt).toContain('Subtask ID:** `2.1`');
      expect(prompt).toContain('Agent session ended without marking the subtask completed.');
      expect(prompt).toContain('Last agent outcome:** completed');
      expect(prompt).toContain('Do not ask the user for confirmation');
      expect(prompt).toContain('Never ask whether to proceed to the next step');
      expect(prompt).toContain('mcp__auto-claude__update_subtask_status');
      expect(prompt).toContain('ONLY subtask `2.1`');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('injects human review feedback into coder subtasks', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-feedback-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');

    try {
      await mkdir(specDir, { recursive: true });
      await writeFile(
        join(specDir, 'QA_FIX_REQUEST.md'),
        '# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nPlease preserve pagination when the tag filter is active.\n',
      );

      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        subtask: {
          id: '2.3',
          description: 'Preserve pagination behavior.',
          phaseName: 'Backend',
          status: 'pending',
        },
      });

      expect(prompt).toContain('HUMAN REVIEW FEEDBACK');
      expect(prompt).toContain('Please preserve pagination when the tag filter is active.');
      expect(prompt).toContain('Do not ignore it just because QA has not run yet.');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('tells retrying coders not to rerun a stalled verification command unchanged', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-stalled-command-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');

    try {
      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        attemptCount: 1,
        subtask: {
          id: '4.2',
          description: 'Verify route smoke coverage.',
          phaseName: 'QA recovery',
          status: 'pending',
          lastError: 'Bash verification command stalled without output and was killed: `pnpm exec playwright test tests/e2e/console-routes.spec.ts`.',
          lastAttemptOutcome: 'completed',
        },
      });

      expect(prompt).toContain('Bash verification command stalled');
      expect(prompt).toContain('Do NOT rerun that same command unchanged');
      expect(prompt).toContain('add verbose/line output');
      expect(prompt).toContain('faster targeted check');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('promotes the safe Yect console route-smoke verifier when retry context mentions console-routes', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-route-smoke-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');

    try {
      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        attemptCount: 1,
        subtask: {
          id: 'aperant-qa-report-failure',
          description: 'Resolve failed QA report.',
          phaseName: 'QA recovery',
          status: 'pending',
          lastError: 'Bash verification command was rejected: `pnpm test:e2e -- --grep "console-routes"`.',
          lastAttemptOutcome: 'completed',
        },
      });

      expect(prompt).toContain('APERANT-SAFE ROUTE SMOKE VERIFICATION');
      expect(prompt).toContain('do NOT use `pnpm test:e2e` wrappers');
      expect(prompt).toContain('LAYER1_CONSOLE_E2E_PORT=$((3200 + $$ % 1000))');
      expect(prompt).toContain('pnpm --filter @yect/layer1-console exec playwright test tests/e2e/console-routes.spec.ts');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('treats failed repo-local verification as implementation work for recovery subtasks', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-failed-verifier-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');

    try {
      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        attemptCount: 1,
        subtask: {
          id: 'aperant-qa-report-failure',
          description: 'Resolve failed QA report.',
          phaseName: 'QA recovery',
          status: 'pending',
          lastError: 'Bash command failed during the attempt: `pnpm --filter @yect/layer1-db build`.\nsrc/queries/index.ts(8,15): error TS2307: Cannot find module ./query-helpers.js',
          lastAttemptOutcome: 'completed',
        },
      });

      expect(prompt).toContain('Do NOT start by rerunning the same command');
      expect(prompt).toContain('TS2307');
      expect(prompt).toContain('treat it as in-scope repair');
      expect(prompt).toContain('APERANT RECOVERY SUBTASK');
      expect(prompt).toContain('The failure text is the implementation target');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders command verification stored in run fields', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'subtask-prompt-run-verification-'));
    const specDir = join(projectDir, '.auto-claude', 'specs', '001-test');

    try {
      const prompt = await generateSubtaskPrompt({
        projectDir,
        specDir,
        subtask: {
          id: 'aperant-base-sync-conflict',
          description: 'Resolve base branch conflicts.',
          phaseName: 'Base branch sync recovery',
          status: 'pending',
          verification: {
            type: 'command',
            run: 'git diff --name-only --diff-filter=U && git status --short',
          },
        },
      });

      expect(prompt).toContain('git diff --name-only --diff-filter=U && git status --short');
      expect(prompt).not.toContain('echo "No command specified"');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
