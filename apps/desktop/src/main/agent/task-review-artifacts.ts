import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

import { AUTO_BUILD_PATHS } from '../../shared/constants';

const PASSING_QA_STATUS = /(?:^|\n)\s*(?:\*\*)?Status(?:\*\*)?\s*:\s*(PASSED|APPROVED)\b/i;

export function isPassingQaReportContent(content: string): boolean {
  return PASSING_QA_STATUS.test(content);
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
