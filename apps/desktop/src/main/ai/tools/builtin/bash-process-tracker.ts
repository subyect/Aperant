import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ACTIVE_COMMANDS_FILE = '.aperant-active-commands.json';

export interface ActiveCommandRecord {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  foreground: boolean;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

export function terminateProcessGroupByPid(pid: number, signal: NodeJS.Signals): void {
  if (!isWindows()) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to direct process kill when the process group is gone.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited; nothing to clean up.
  }
}

function activeCommandsPath(specDir: string): string {
  return join(specDir, ACTIVE_COMMANDS_FILE);
}

async function readActiveCommands(specDir: string): Promise<ActiveCommandRecord[]> {
  try {
    const raw = await readFile(activeCommandsPath(specDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is ActiveCommandRecord => (
      typeof record === 'object'
      && record !== null
      && typeof (record as ActiveCommandRecord).pid === 'number'
      && typeof (record as ActiveCommandRecord).command === 'string'
      && typeof (record as ActiveCommandRecord).cwd === 'string'
      && typeof (record as ActiveCommandRecord).startedAt === 'string'
      && typeof (record as ActiveCommandRecord).foreground === 'boolean'
    ));
  } catch {
    return [];
  }
}

async function writeActiveCommands(
  specDir: string,
  records: ActiveCommandRecord[],
): Promise<void> {
  const filePath = activeCommandsPath(specDir);
  if (records.length === 0) {
    await rm(filePath, { force: true });
    return;
  }
  await writeFile(filePath, JSON.stringify(records, null, 2));
}

export async function registerActiveCommand(
  specDir: string,
  record: ActiveCommandRecord,
): Promise<void> {
  const records = await readActiveCommands(specDir);
  const withoutCurrent = records.filter((existing) => existing.pid !== record.pid);
  withoutCurrent.push(record);
  await writeActiveCommands(specDir, withoutCurrent);
}

export async function unregisterActiveCommand(specDir: string, pid: number): Promise<void> {
  const records = await readActiveCommands(specDir);
  await writeActiveCommands(
    specDir,
    records.filter((record) => record.pid !== pid),
  );
}

/**
 * Clear foreground Bash commands left behind by a crashed/restarted worker.
 *
 * Foreground commands should be scoped to a single subtask attempt. If the
 * worker exits before the Bash tool resolves, the detached process group can
 * otherwise survive and block every later retry.
 */
export async function cleanupStaleForegroundCommands(specDir: string): Promise<number> {
  const records = await readActiveCommands(specDir);
  let killed = 0;

  for (const record of records) {
    if (!record.foreground) continue;
    terminateProcessGroupByPid(record.pid, 'SIGTERM');
    killed += 1;
  }

  await writeActiveCommands(
    specDir,
    records.filter((record) => !record.foreground),
  );

  return killed;
}
