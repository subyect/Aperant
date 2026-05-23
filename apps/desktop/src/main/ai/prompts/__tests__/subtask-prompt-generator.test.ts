import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
