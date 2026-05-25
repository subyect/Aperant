import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filterIdeationIdeasAgainstExistingTasks } from '../file-utils';

describe('ideation file utils', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(tmpdir(), 'aperant-ideation-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('filters ideas that duplicate existing task slugs even when plan title drifted', () => {
    const specDir = path.join(
      projectDir,
      '.auto-claude',
      'specs',
      '001-create-a-leadgen-shared-worker-execution-scaffold',
    );
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      path.join(specDir, 'implementation_plan.json'),
      JSON.stringify({
        title: 'Leadgen worker runtime',
        status: 'done',
        phases: [],
      }),
      'utf-8',
    );

    const result = filterIdeationIdeasAgainstExistingTasks(projectDir, [
      {
        id: 'idea-1',
        type: 'code_improvements',
        title: 'Create a leadgen shared worker execution scaffold',
        description: 'Duplicate of an existing task',
        rationale: 'Already implemented',
      },
      {
        id: 'idea-2',
        type: 'code_improvements',
        title: 'Add rate limit diagnostics to task recovery',
        description: 'New idea',
        rationale: 'Improves operations',
      },
    ]);

    expect(result.removed.map((idea) => idea.title)).toEqual([
      'Create a leadgen shared worker execution scaffold',
    ]);
    expect(result.filtered.map((idea) => idea.title)).toEqual([
      'Add rate limit diagnostics to task recovery',
    ]);
  });

  it('filters lifecycle split ideas that duplicate already merged decomposition tasks', () => {
    const specDir = path.join(
      projectDir,
      '.auto-claude',
      'specs',
      '008-decompose-worker-loop-engine-into-explicit-lifecyc',
    );
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      path.join(specDir, 'implementation_plan.json'),
      JSON.stringify({
        feature: 'Decompose worker loop engine into explicit lifecycle stages',
        status: 'done',
        phases: [],
      }),
      'utf-8',
    );

    const result = filterIdeationIdeasAgainstExistingTasks(projectDir, [
      {
        id: 'idea-duplicate',
        type: 'code_quality',
        title: 'Split the worker loop engine into lifecycle throttle modules',
        description: 'Duplicate of an already merged lifecycle split',
        rationale: 'Already implemented',
      },
      {
        id: 'idea-new',
        type: 'code_quality',
        title: 'Extract retry metrics from worker logs',
        description: 'New worker observability cleanup',
        rationale: 'Improves debugging',
      },
    ]);

    expect(result.removed.map((idea) => idea.title)).toEqual([
      'Split the worker loop engine into lifecycle throttle modules',
    ]);
    expect(result.filtered.map((idea) => idea.title)).toEqual([
      'Extract retry metrics from worker logs',
    ]);
  });
});
