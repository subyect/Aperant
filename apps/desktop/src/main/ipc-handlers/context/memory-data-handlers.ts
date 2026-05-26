import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getSpecsDir, IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  RendererMemory,
  ContextSearchResult,
  MemoryType,
} from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getMemoryService } from './memory-service-factory';
import type { Memory } from '../../ai/memory/types';

interface FileSessionInsights {
  file_insights?: Array<{ file?: string; insight?: string; category?: string }>;
  patterns_discovered?: string[];
  gotchas_discovered?: string[];
  approach_outcome?: {
    success?: boolean;
    approach_used?: string;
    why_it_worked?: string | null;
    why_it_failed?: string | null;
  };
  recommendations?: string[];
  subtask_id?: string;
  subtask_description?: string;
  session_num?: number;
  success?: boolean;
  changed_files?: string[];
  captured_at?: string;
}

// ============================================================
// MAPPING HELPER
// ============================================================

function toRendererMemory(m: Memory): RendererMemory {
  return {
    id: m.id,
    type: m.type as MemoryType,
    content: m.content,
    confidence: m.confidence,
    tags: m.tags,
    relatedFiles: m.relatedFiles,
    relatedModules: m.relatedModules,
    createdAt: m.createdAt,
    lastAccessedAt: m.lastAccessedAt,
    accessCount: m.accessCount,
    scope: m.scope as RendererMemory['scope'],
    source: m.source as RendererMemory['source'],
    needsReview: m.needsReview,
    userVerified: m.userVerified,
    citationText: m.citationText,
    pinned: m.pinned,
    methodology: m.methodology,
    deprecated: m.deprecated,
  };
}

function makeFileMemory(
  sourceFile: string,
  index: number,
  projectId: string,
  type: MemoryType,
  content: string,
  capturedAt: string,
  insights: FileSessionInsights,
  relatedFiles: string[] = [],
  tags: string[] = [],
): RendererMemory {
  return {
    id: `session-insight:${sourceFile}:${index}`,
    type,
    content,
    confidence: 0.72,
    tags: ['session-insight', insights.subtask_id ?? 'unknown-subtask', ...tags],
    relatedFiles,
    relatedModules: [],
    createdAt: capturedAt,
    lastAccessedAt: capturedAt,
    accessCount: 0,
    scope: 'work_unit',
    source: 'observer_inferred',
    needsReview: false,
    userVerified: false,
    pinned: false,
    methodology: `Aperant subtask ${insights.subtask_id ?? 'unknown'}`,
    deprecated: false,
  };
}

function parseSessionInsightFile(filePath: string): FileSessionInsights | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as FileSessionInsights;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadFileBackedMemories(
  projectPath: string,
  autoBuildPath: string | undefined,
  projectId: string,
  limit = 100,
): RendererMemory[] {
  const specsDir = path.join(projectPath, getSpecsDir(autoBuildPath));
  if (!existsSync(specsDir)) return [];

  const memories: RendererMemory[] = [];
  for (const specEntry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!specEntry.isDirectory()) continue;
    const insightsDir = path.join(specsDir, specEntry.name, 'memory', 'session_insights');
    if (!existsSync(insightsDir)) continue;

    for (const file of readdirSync(insightsDir).filter((name) => name.endsWith('.json'))) {
      const filePath = path.join(insightsDir, file);
      const insights = parseSessionInsightFile(filePath);
      if (!insights) continue;

      const capturedAt = insights.captured_at ?? statSync(filePath).mtime.toISOString();
      let index = 0;
      for (const pattern of insights.patterns_discovered ?? []) {
        if (pattern.trim()) {
          memories.push(makeFileMemory(filePath, index++, projectId, 'pattern', pattern, capturedAt, insights, [], ['pattern']));
        }
      }
      for (const gotcha of insights.gotchas_discovered ?? []) {
        if (gotcha.trim()) {
          memories.push(makeFileMemory(filePath, index++, projectId, 'gotcha', gotcha, capturedAt, insights, [], ['gotcha']));
        }
      }
      for (const recommendation of insights.recommendations ?? []) {
        if (recommendation.trim()) {
          memories.push(makeFileMemory(filePath, index++, projectId, 'module_insight', recommendation, capturedAt, insights, [], ['recommendation']));
        }
      }
      for (const fileInsight of insights.file_insights ?? []) {
        if (fileInsight.insight?.trim()) {
          const relatedFile = fileInsight.file ? [fileInsight.file] : [];
          memories.push(makeFileMemory(filePath, index++, projectId, 'module_insight', fileInsight.insight, capturedAt, insights, relatedFile, ['file-insight']));
        }
      }

      const outcome = insights.approach_outcome;
      if (outcome?.why_it_worked?.trim()) {
        memories.push(makeFileMemory(filePath, index++, projectId, 'work_unit_outcome', outcome.why_it_worked, capturedAt, insights, insights.changed_files ?? [], ['outcome']));
      }
      if (outcome?.why_it_failed?.trim()) {
        memories.push(makeFileMemory(filePath, index++, projectId, 'dead_end', outcome.why_it_failed, capturedAt, insights, insights.changed_files ?? [], ['dead-end']));
      }
    }
  }

  return memories
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function filterFileMemories(memories: RendererMemory[], query: string): RendererMemory[] {
  const needle = query.toLowerCase();
  return memories.filter((memory) =>
    memory.content.toLowerCase().includes(needle)
    || memory.tags.some((tag) => tag.toLowerCase().includes(needle))
    || memory.relatedFiles.some((file) => file.toLowerCase().includes(needle))
  );
}

// ============================================================
// REGISTER HANDLERS
// ============================================================

/**
 * Register memory data handlers
 */
export function registerMemoryDataHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  // Get all memories (sorted by recency)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_GET_MEMORIES,
    async (_, projectId: string, limit: number = 20): Promise<IPCResult<RendererMemory[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = await getMemoryService();
        const dbMemories = await service.search({
          projectId,
          limit,
          sort: 'recency',
          excludeDeprecated: true,
        });
        const fileMemories = loadFileBackedMemories(project.path, project.autoBuildPath, projectId, limit);
        const memories = [
          ...dbMemories.map(toRendererMemory),
          ...fileMemories,
        ]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, limit);
        return { success: true, data: memories };
      } catch {
        return {
          success: true,
          data: loadFileBackedMemories(project.path, project.autoBuildPath, projectId, limit),
        };
      }
    }
  );

  // Verify a memory (mark as user-verified)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_VERIFY,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.verifyMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to verify memory' };
      }
    }
  );

  // Pin/unpin a memory
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_PIN,
    async (_, memoryId: string, pinned: boolean): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.pinMemory(memoryId, pinned);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to pin memory' };
      }
    }
  );

  // Deprecate a memory (soft delete)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_DEPRECATE,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.deprecateMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to deprecate memory' };
      }
    }
  );

  // Delete a memory permanently
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_DELETE,
    async (_, memoryId: string): Promise<IPCResult<void>> => {
      try {
        const service = await getMemoryService();
        await service.deleteMemory(memoryId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to delete memory' };
      }
    }
  );

  // Search memories
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_SEARCH_MEMORIES,
    async (_, projectId: string, query: string): Promise<IPCResult<ContextSearchResult[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const service = await getMemoryService();
        const dbMemories = await service.search({
          query,
          projectId,
          limit: 20,
          excludeDeprecated: true,
        });
        const fileMemories = filterFileMemories(
          loadFileBackedMemories(project.path, project.autoBuildPath, projectId, 100),
          query,
        ).slice(0, 20);
        const memories = [...dbMemories.map(toRendererMemory), ...fileMemories].slice(0, 20);
        return {
          success: true,
          data: memories.map((m) => ({
            content: m.content,
            score: m.confidence,
            type: m.type,
          })),
        };
      } catch {
        const memories = filterFileMemories(
          loadFileBackedMemories(project.path, project.autoBuildPath, projectId, 100),
          query,
        ).slice(0, 20);
        return {
          success: true,
          data: memories.map((m) => ({
            content: m.content,
            score: m.confidence,
            type: m.type,
          })),
        };
      }
    }
  );
}
