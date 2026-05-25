import { existsSync, readFileSync } from 'node:fs';

import { writeFileAtomicSync } from './utils/atomic-file';

const MAX_QA_FEEDBACK_UNWRAP_DEPTH = 12;

function extractFailedQaReportBlock(content: string): string | null {
  const heading = /^##\s+Failed QA Report\s*$/gim.exec(content);
  if (!heading) return null;

  const afterHeading = content.slice(heading.index + heading[0].length);
  const fenced = afterHeading.match(/```(?:markdown|md)?[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*(?:\r?\n|$)/i);
  if (fenced?.[1]?.trim()) {
    return fenced[1].trim();
  }

  const unfenced = afterHeading
    .replace(/^\s*```(?:markdown|md)?\s*/i, '')
    .replace(/\r?\n```[\s\S]*$/i, '')
    .trim();
  return unfenced || null;
}

function extractFeedbackSection(content: string): string | null {
  const heading = /^##\s+Feedback\s*$/gim.exec(content);
  if (!heading) return null;

  const afterHeading = content.slice(heading.index + heading[0].length);
  const nextHeading = /\r?\n##\s+/g.exec(afterHeading);
  const section = (nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading)
    .replace(/\r?\nCreated at:\s*.+$/i, '')
    .trim();

  return section || null;
}

function unwrapNestedFailedQaReport(content: string): string {
  let current = content.trim();
  const seen = new Set<string>();

  for (let depth = 0; depth < MAX_QA_FEEDBACK_UNWRAP_DEPTH; depth += 1) {
    if (!current || seen.has(current)) break;
    seen.add(current);

    const nested = extractFailedQaReportBlock(current);
    if (!nested || nested === current) break;
    current = nested.trim();
  }

  return current;
}

function stripGeneratedFooter(content: string): string {
  const lines = content.trim().split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? '';
    if (!last || last === '```' || /^Created at:\s*/i.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

function extractLastFailedStatusBlock(content: string): string | null {
  const matches = Array.from(content.matchAll(
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:Status|Final Status|Result)\s*(?:\*\*)?\s*:\s*(?:\*\*)?\s*(FAILED|FAIL|ISSUES|ESCALATED|MAX ITERATIONS REACHED)\b[\s\S]*$/gi
  ));
  const last = matches.at(-1)?.[0]?.trim();
  return last ? stripGeneratedFooter(last) : null;
}

/**
 * QA_FIX_REQUEST.md can be regenerated after each failed review. Older builds
 * wrapped the previous fix request inside the new one, producing huge recursive
 * prompts. Normalize that file back to the actionable failure text.
 */
export function normalizeQaFailureEvidenceContent(content: string): string {
  const unwrapped = unwrapNestedFailedQaReport(content);
  const failedStatusBlock = extractLastFailedStatusBlock(unwrapped);
  if (failedStatusBlock) return failedStatusBlock;

  const feedback = extractFeedbackSection(unwrapped);
  return (feedback ?? unwrapped).trim();
}

export function buildQaFixRequestContent(failureContent: string, createdAt = new Date().toISOString()): string {
  return [
    '# QA Fix Request',
    '',
    'Status: REJECTED',
    '',
    '## Feedback',
    '',
    'Aperant QA failed this task. Fix the reported issues and keep working until QA passes.',
    '',
    '## Failed QA Report',
    '',
    '```markdown',
    normalizeQaFailureEvidenceContent(failureContent) || '(empty qa_report.md)',
    '```',
    '',
    `Created at: ${createdAt}`,
    '',
  ].join('\n');
}

export function normalizeQaFixRequestFileSync(filePath: string, createdAt = new Date().toISOString()): boolean {
  if (!existsSync(filePath)) return false;

  const content = readFileSync(filePath, 'utf-8');
  const wrapperCount = (content.match(/^#\s+QA Fix Request\b/gim) ?? []).length;
  const failedReportCount = (content.match(/^##\s+Failed QA Report\s*$/gim) ?? []).length;
  if (wrapperCount <= 1 && failedReportCount <= 1) return false;

  const normalized = buildQaFixRequestContent(content, createdAt);
  if (normalized.trim() === content.trim()) return false;

  writeFileAtomicSync(filePath, normalized);
  return true;
}
