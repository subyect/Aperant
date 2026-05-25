import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  copyReviewArtifactsToMainSpec,
  findPassingQaReport,
  hasPassingQaReport,
  isPassingQaReportContent,
} from './task-review-artifacts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aperant-review-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      // Tests only create temporary directories under os.tmpdir().
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('task review artifacts', () => {
  it('recognizes passed and approved QA report status lines', () => {
    expect(isPassingQaReportContent('# QA\n\nStatus: PASSED\n')).toBe(true);
    expect(isPassingQaReportContent('# QA\n\n**Status**: APPROVED\n')).toBe(true);
    expect(isPassingQaReportContent('# QA\n\nStatus: FAILED\n')).toBe(false);
  });

  it('finds a passing qa_report.md across candidate spec dirs', () => {
    const first = makeTempDir();
    const second = makeTempDir();
    writeFileSync(path.join(first, 'qa_report.md'), 'Status: FAILED\n');
    writeFileSync(path.join(second, 'qa_report.md'), 'Status: PASSED\n');

    expect(findPassingQaReport([first, second])).toBe(path.join(second, 'qa_report.md'));
    expect(hasPassingQaReport([first, second])).toBe(true);
  });

  it('copies review artifacts from worktree spec dir into main spec dir', () => {
    const mainSpecDir = makeTempDir();
    const worktreeSpecDir = makeTempDir();
    mkdirSync(worktreeSpecDir, { recursive: true });
    writeFileSync(path.join(worktreeSpecDir, 'qa_report.md'), 'Status: PASSED\n');
    writeFileSync(path.join(worktreeSpecDir, 'QA_ESCALATION.md'), 'extra context\n');

    expect(copyReviewArtifactsToMainSpec(mainSpecDir, worktreeSpecDir)).toEqual([
      'qa_report.md',
      'QA_ESCALATION.md',
    ]);
    expect(existsSync(path.join(mainSpecDir, 'qa_report.md'))).toBe(true);
    expect(readFileSync(path.join(mainSpecDir, 'QA_ESCALATION.md'), 'utf-8')).toBe('extra context\n');
  });
});
