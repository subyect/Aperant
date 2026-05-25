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
      expect(prompt).toContain('set ONLY this subtask');
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
