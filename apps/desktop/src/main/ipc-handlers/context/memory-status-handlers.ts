import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import path from 'path';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, MemorySystemStatus } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { getMemoryService, getEmbeddingProvider } from './memory-service-factory';
import { loadFileBackedMemories } from './memory-data-handlers';

/**
 * Build memory system status by probing the libSQL database and embedding service.
 * Gracefully returns unavailable status if initialization fails.
 */
export async function buildMemoryStatus(projectId?: string): Promise<MemorySystemStatus> {
  const project = projectId ? projectStore.getProject(projectId) : null;
  const fileMemoryCount = project
    ? loadFileBackedMemories(project.path, project.autoBuildPath, projectId ?? project.id, 100000).length
    : 0;

  try {
    const service = await getMemoryService();
    // If we got a service instance the DB and embedding layer are up
    const embeddingProvider = getEmbeddingProvider() ?? 'unknown';
    const memories = await service.search({
      ...(projectId ? { projectId } : {}),
      limit: 100000,
      excludeDeprecated: true,
      sort: 'recency',
    });

    return {
      enabled: true,
      available: true,
      database: 'memory.db',
      dbPath: path.join(app.getPath('userData'), 'memory.db'),
      embeddingProvider,
      totalMemories: memories.length + fileMemoryCount,
      ...(embeddingProvider === 'none' && {
        reason:
          'No embedding provider found. Install Ollama with an embedding model or set OPENAI_API_KEY.',
      }),
    };
  } catch {
    if (fileMemoryCount > 0) {
      return {
        enabled: true,
        available: true,
        database: 'session_insights',
        dbPath: project ? path.join(project.path, project.autoBuildPath ?? '.auto-claude', 'specs') : undefined,
        embeddingProvider: 'file',
        totalMemories: fileMemoryCount,
      };
    }

    return {
      enabled: false,
      available: false,
      reason: 'Memory service initialization failed',
    };
  }
}

/**
 * Register memory status handlers
 */
export function registerMemoryStatusHandlers(
  _getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_MEMORY_STATUS,
    async (_event, _projectId: string): Promise<IPCResult<MemorySystemStatus>> => {
      const project = _projectId ? projectStore.getProject(_projectId) : null;
      if (_projectId && !project) {
        return { success: false, error: 'Project not found' };
      }

      try {
        const memoryStatus = await buildMemoryStatus(_projectId);
        return { success: true, data: memoryStatus };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check memory status',
        };
      }
    }
  );
}
