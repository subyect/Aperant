/**
 * File system utilities for ideation operations
 */

import path from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { AUTO_BUILD_PATHS } from '../../../shared/constants';
import type { RawIdea, RawIdeationData } from './types';

const VALID_IDEATION_TYPES = [
  'code_improvements',
  'ui_ux_improvements',
  'documentation_gaps',
  'security_hardening',
  'performance_optimizations',
  'code_quality',
] as const;

type IdeationType = (typeof VALID_IDEATION_TYPES)[number];

/**
 * Read ideation data from file
 */
export function readIdeationFile(ideationPath: string): RawIdeationData | null {
  if (!existsSync(ideationPath)) {
    return null;
  }

  try {
    const content = readFileSync(ideationPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to read ideation file'
    );
  }
}

/**
 * Write ideation data to file
 */
export function writeIdeationFile(ideationPath: string, data: RawIdeationData): void {
  try {
    writeFileSync(ideationPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to write ideation file'
    );
  }
}

export function getIdeationTypeOutputFileName(ideationType: string): string {
  return `${ideationType}_ideas.json`;
}

export function getIdeationIdeasFromTypeData(data: Record<string, unknown>, ideationType: string): RawIdea[] {
  const direct = data[ideationType];
  if (Array.isArray(direct)) return direct as RawIdea[];
  const ideas = data.ideas;
  return Array.isArray(ideas) ? ideas as RawIdea[] : [];
}

function normalizeIdeationComparable(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function addComparableTitle(target: Set<string>, value: unknown): void {
  const normalized = normalizeIdeationComparable(value);
  if (normalized) target.add(normalized);
}

function titleFromSpecId(specId: string): string {
  return specId
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(a.split(' ').filter(Boolean));
  const bTokens = new Set(b.split(' ').filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }

  return overlap / Math.max(aTokens.size, bTokens.size);
}

function collectIdeationTaskContext(projectPath: string): { titleKeys: Set<string>; tasks: Array<{ title: string; titleKey: string; status: string }> } {
  const specsDir = path.join(projectPath, AUTO_BUILD_PATHS.SPECS_DIR);
  const tasks: Array<{ title: string; titleKey: string; status: string }> = [];
  const titleKeys = new Set<string>();
  if (!existsSync(specsDir)) return { titleKeys: new Set(), tasks };

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(specsDir, { withFileTypes: true });
  } catch {
    return { titleKeys: new Set(), tasks };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const specId = entry.name;
    const specDir = path.join(specsDir, specId);
    let title = specId;
    let status = 'unknown';
    const aliases = new Set<string>();
    addComparableTitle(aliases, specId);
    addComparableTitle(aliases, titleFromSpecId(specId));
    try {
      const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
      if (existsSync(planPath)) {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
        title = String(plan.feature || plan.title || title);
        status = String(plan.status || plan.planStatus || status);
        addComparableTitle(aliases, plan.feature);
        addComparableTitle(aliases, plan.title);
        addComparableTitle(aliases, plan.description);
      } else {
        const specPath = path.join(specDir, AUTO_BUILD_PATHS.SPEC_FILE);
        const content = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : '';
        const match = content.match(/^#\s+(?:Quick Spec:|Specification:)?\s*(.+)$/m);
        if (match?.[1]) title = match[1].trim();
        addComparableTitle(aliases, match?.[1]);
      }
    } catch {
      // Keep best-effort fallback title.
    }
    addComparableTitle(aliases, title);
    const titleKey = normalizeIdeationComparable(title);
    if (titleKey) {
      tasks.push({ title, titleKey, status });
      for (const alias of aliases) titleKeys.add(alias);
    }
  }

  return { titleKeys, tasks };
}

export function filterIdeationIdeasAgainstExistingTasks(projectPath: string, ideas: RawIdea[]): {
  filtered: RawIdea[];
  removed: RawIdea[];
} {
  const taskContext = collectIdeationTaskContext(projectPath);
  const filtered: RawIdea[] = [];
  const removed: RawIdea[] = [];
  for (const idea of Array.isArray(ideas) ? ideas : []) {
    const titleKey = normalizeIdeationComparable(idea?.title);
    const duplicate = titleKey && (
      taskContext.titleKeys.has(titleKey)
      || taskContext.tasks.some((task) => titleKey.length > 30 && task.titleKey.length > 30 && (titleKey.includes(task.titleKey) || task.titleKey.includes(titleKey)))
      || Array.from(taskContext.titleKeys).some((taskTitleKey) => titleKey.length > 30 && taskTitleKey.length > 30 && tokenSimilarity(titleKey, taskTitleKey) >= 0.82)
    );
    if (duplicate) removed.push(idea);
    else filtered.push(idea);
  }
  return { filtered, removed };
}

export function writeIdeationContextFile(projectPath: string, outputDir: string): string | null {
  const taskContext = collectIdeationTaskContext(projectPath);
  const contextPath = path.join(outputDir, AUTO_BUILD_PATHS.IDEATION_CONTEXT);
  try {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    writeFileSync(contextPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      existing_task_titles: taskContext.tasks.map((task) => task.title),
      planned_features: taskContext.tasks.map((task) => ({
        title: task.title,
        status: task.status,
      })),
    }, null, 2), 'utf-8');
    return contextPath;
  } catch {
    return null;
  }
}

export function filterIdeationTypeFileAgainstExistingTasks(projectPath: string, outputFile: string, ideationType: string): { removed: RawIdea[]; remaining: number } {
  try {
    const data = JSON.parse(readFileSync(outputFile, 'utf-8')) as Record<string, unknown>;
    const rawIdeas = getIdeationIdeasFromTypeData(data, ideationType);
    const { filtered, removed } = filterIdeationIdeasAgainstExistingTasks(projectPath, rawIdeas);
    if (removed.length > 0) {
      data[ideationType] = filtered;
      writeFileSync(outputFile, JSON.stringify(data, null, 2), 'utf-8');
    }
    return { removed, remaining: filtered.length };
  } catch {
    return { removed: [], remaining: 0 };
  }
}

export function filterIdeationSessionAgainstExistingTasks(projectPath: string, session: RawIdeationData): { session: RawIdeationData; removed: RawIdea[] } {
  if (!session || !Array.isArray(session.ideas)) return { session, removed: [] };
  const { filtered, removed } = filterIdeationIdeasAgainstExistingTasks(projectPath, session.ideas);
  if (removed.length === 0) return { session, removed };
  return {
    session: {
      ...session,
      ideas: filtered,
      updated_at: new Date().toISOString(),
    },
    removed,
  };
}

export function synthesizeIdeationFromTypeFiles(projectPath: string): RawIdeationData | null {
  const ideationDir = path.join(projectPath, AUTO_BUILD_PATHS.IDEATION_DIR);
  if (!existsSync(ideationDir)) return null;
  const ideas: RawIdea[] = [];
  const enabledTypes: string[] = [];
  let latestMtime = 0;
  let earliestMtime = Infinity;

  for (const ideationType of VALID_IDEATION_TYPES) {
    const typeFilePath = path.join(ideationDir, getIdeationTypeOutputFileName(ideationType));
    if (!existsSync(typeFilePath)) continue;
    try {
      const stat = statSync(typeFilePath);
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
      earliestMtime = Math.min(earliestMtime, stat.mtimeMs);
      const data = JSON.parse(readFileSync(typeFilePath, 'utf-8')) as Record<string, unknown>;
      const rawIdeas = getIdeationIdeasFromTypeData(data, ideationType);
      const { filtered } = filterIdeationIdeasAgainstExistingTasks(projectPath, rawIdeas);
      if (filtered.length > 0) enabledTypes.push(ideationType);
      for (const idea of filtered) {
        ideas.push({
          ...idea,
          type: VALID_IDEATION_TYPES.includes(String(idea.type) as IdeationType) ? idea.type : ideationType,
          status: idea.status || 'draft',
          created_at: idea.created_at || new Date(stat.mtimeMs).toISOString(),
        });
      }
    } catch {
      // Ignore malformed type files; other types may still be usable.
    }
  }

  if (ideas.length === 0) return null;
  const generatedAt = Number.isFinite(earliestMtime) ? new Date(earliestMtime) : new Date();
  const updatedAt = latestMtime > 0 ? new Date(latestMtime) : new Date();
  return {
    id: `ideation-${updatedAt.getTime()}`,
    config: {
      enabled_types: enabledTypes,
      include_roadmap_context: true,
      include_kanban_context: true,
      max_ideas_per_type: Math.max(1, ...enabledTypes.map((type) => ideas.filter((idea) => idea.type === type).length)),
    },
    ideas,
    project_context: {
      existing_features: [],
      tech_stack: [],
      planned_features: [],
    },
    generated_at: generatedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  };
}

export function ensureIdeationSessionFile(projectPath: string): RawIdeationData | null {
  const ideationPath = path.join(projectPath, AUTO_BUILD_PATHS.IDEATION_DIR, AUTO_BUILD_PATHS.IDEATION_FILE);
  const existing = readIdeationFile(ideationPath);
  const synthesized = synthesizeIdeationFromTypeFiles(projectPath);
  if (!existing) {
    if (!synthesized) return null;
    writeIdeationFile(ideationPath, synthesized);
    return synthesized;
  }
  const { session: filteredExisting, removed } = filterIdeationSessionAgainstExistingTasks(projectPath, existing);
  if (removed.length > 0) writeIdeationFile(ideationPath, filteredExisting);
  if (!synthesized) return filteredExisting;
  const existingUpdatedAt = filteredExisting.updated_at ? new Date(filteredExisting.updated_at).getTime() : 0;
  const synthesizedUpdatedAt = synthesized.updated_at ? new Date(synthesized.updated_at).getTime() : 0;
  const existingIdeaCount = Array.isArray(filteredExisting.ideas) ? filteredExisting.ideas.length : 0;
  const synthesizedIdeaCount = Array.isArray(synthesized.ideas) ? synthesized.ideas.length : 0;
  if (synthesizedUpdatedAt > existingUpdatedAt || synthesizedIdeaCount > existingIdeaCount) {
    writeIdeationFile(ideationPath, synthesized);
    return synthesized;
  }
  return filteredExisting;
}

/**
 * Update timestamp for ideation data
 */
export function updateIdeationTimestamp(data: RawIdeationData): void {
  data.updated_at = new Date().toISOString();
}
