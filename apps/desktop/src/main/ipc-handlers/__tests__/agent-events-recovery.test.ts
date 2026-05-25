import { describe, expect, it } from 'vitest';

import { processTypeCanEmitQaResult } from '../agent-events-recovery';

describe('processTypeCanEmitQaResult', () => {
  it('recovers QA artifacts from standalone QA and task execution processes', () => {
    expect(processTypeCanEmitQaResult('qa-process')).toBe(true);
    expect(processTypeCanEmitQaResult('task-execution')).toBe(true);
  });

  it('does not treat spec creation as a QA result producer', () => {
    expect(processTypeCanEmitQaResult('spec-creation')).toBe(false);
  });
});
