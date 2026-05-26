import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

import { AUTO_BUILD_PATHS } from '../../shared/constants';

const QA_STATUS_LINE = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASSED|PASS|APPROVED|FAILED|FAIL|REJECTED|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\s*(?:\*\*)?/i;
const APPROVED_STATUSES = new Set(['passed', 'pass', 'approved']);

const CONTRADICTORY_FAILURE_PATTERNS = [
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(FAILED|FAIL|REJECTED|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\b/i,
  /\b(?:test suite|tests?)\s+(?:has|have|had)\s+(?:unrelated\s+)?failures?\b/i,
  /\b(?:verification|verifier|command|test run|suite)\b[^\n]*(?:failed|failing|failure|did not pass|not passing)\b/i,
  /\bverification\s+(?:could not|cannot|did not)\s+complete\b/i,
  /\bnot ready for sign[- ]off\b/i,
  /\bcannot be accepted\b/i,
  /❌\s*(?:failed|fail|failing)/i,
];

export function hasContradictoryFailureEvidence(content: string): boolean {
  return CONTRADICTORY_FAILURE_PATTERNS.some((pattern) => pattern.test(content));
}

export function getQaReportVerdictFromContent(content: string): 'approved' | 'failed' | null {
  const match = content.match(QA_STATUS_LINE);
  if (!match) return null;

  const normalized = match[1].toLowerCase();
  const status = APPROVED_STATUSES.has(normalized) ? 'approved' : 'failed';
  if (status === 'approved' && hasContradictoryFailureEvidence(content)) {
    return 'failed';
  }

  return status;
}

export function isPassingQaReportContent(content: string): boolean {
  return getQaReportVerdictFromContent(content) === 'approved';
}

export function findPassingQaReport(specDirs: string[]): string | null {
  for (const specDir of specDirs) {
    const reportPath = path.join(specDir, AUTO_BUILD_PATHS.QA_REPORT);
    if (!existsSync(reportPath)) continue;
    try {
      const content = readFileSync(reportPath, 'utf-8');
      if (isPassingQaReportContent(content)) return reportPath;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function hasPassingQaReport(specDirs: string[]): boolean {
  return findPassingQaReport(specDirs) !== null;
}

export function copyReviewArtifactsToMainSpec(mainSpecDir: string, sourceSpecDir: string): string[] {
  if (path.resolve(mainSpecDir) === path.resolve(sourceSpecDir)) return [];

  const copied: string[] = [];
  const artifactNames = [
    AUTO_BUILD_PATHS.QA_REPORT,
    'QA_ESCALATION.md',
  ];

  mkdirSync(mainSpecDir, { recursive: true });
  for (const artifactName of artifactNames) {
    const sourcePath = path.join(sourceSpecDir, artifactName);
    if (!existsSync(sourcePath)) continue;
    const targetPath = path.join(mainSpecDir, artifactName);
    copyFileSync(sourcePath, targetPath);
    copied.push(artifactName);
  }

  return copied;
}
