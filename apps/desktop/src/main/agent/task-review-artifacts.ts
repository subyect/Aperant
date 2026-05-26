import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

import { AUTO_BUILD_PATHS } from '../../shared/constants';

const QA_STATUS_LINE = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(PASSED|PASS|APPROVED|FAILED|FAIL|REJECTED|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\s*(?:\*\*)?/i;
const APPROVED_STATUSES = new Set(['passed', 'pass', 'approved']);

const CONTRADICTORY_FAILURE_PATTERNS = [
  /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(FAILED|FAIL|REJECTED|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\b/i,
  /\b(?:test suite|tests?)\s+(?:has|have|had)\s+(?:unrelated\s+)?failures?\b/i,
  /\b(?:verification|verifier|command|test run|suite)\b[^\n]*(?:failed|fails|failing|failure|did not pass|does not pass|not passing)\b/i,
  /\bverification\s+(?:could not|cannot|did not)\s+complete\b/i,
  /\bnot ready for sign[- ]off\b/i,
  /\bcannot be accepted\b/i,
  /❌\s*(?:failed|fail|failing)/i,
];

const OUT_OF_SCOPE_FAILURE_PATTERN = /\b(?:unrelated|outside (?:the )?(?:narrow )?(?:target|scope)|not scoped|not in scope|downstream suites? not scoped)\b/i;
const SCOPED_PASS_EVIDENCE_PATTERN = /\b(?:focused|targeted|task-specific|scope-specific|refactor-specific|implementation-specific)\b[\s\S]{0,160}\b(?:pass(?:ed|es)?|green|align(?:s|ed)?|satisf(?:y|ies|ied))\b/i;

export function hasContradictoryFailureEvidence(content: string): boolean {
  const hasFailureEvidence = CONTRADICTORY_FAILURE_PATTERNS.some((pattern) => pattern.test(content));
  if (!hasFailureEvidence) return false;

  // A scoped QA pass may honestly mention a broader workspace/package command
  // that fails outside the task boundary. Do not turn that into a failed QA
  // verdict when the report also records task-scoped passing evidence.
  if (OUT_OF_SCOPE_FAILURE_PATTERN.test(content) && SCOPED_PASS_EVIDENCE_PATTERN.test(content)) {
    return false;
  }

  return true;
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
