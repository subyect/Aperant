import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupStaleRateLimitPauseFile,
  RATE_LIMIT_PAUSE_FILE,
} from '../pause-handler';

const tempDirs: string[] = [];

function makeSpecDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aperant-pause-handler-'));
  tempDirs.push(dir);
  return dir;
}

function writePauseFile(specDir: string, data: Record<string, unknown>): void {
  writeFileSync(join(specDir, RATE_LIMIT_PAUSE_FILE), JSON.stringify(data, null, 2), 'utf-8');
}

function pauseFileExists(specDir: string): boolean {
  try {
    readFileSync(join(specDir, RATE_LIMIT_PAUSE_FILE), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

describe('pause-handler stale cleanup', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes no-reset rate-limit pause files older than the maximum wait', () => {
    const specDir = makeSpecDir();
    const now = Date.parse('2026-05-25T10:00:00.000Z');
    writePauseFile(specDir, {
      pausedAt: '2026-05-25T07:59:59.000Z',
      resetTimestamp: null,
      error: 'usage limit reached',
    });

    expect(cleanupStaleRateLimitPauseFile(specDir, now)).toBe(true);
    expect(pauseFileExists(specDir)).toBe(false);
  });

  it('keeps recent no-reset rate-limit pause files', () => {
    const specDir = makeSpecDir();
    const now = Date.parse('2026-05-25T10:00:00.000Z');
    writePauseFile(specDir, {
      pausedAt: '2026-05-25T09:30:00.000Z',
      resetTimestamp: null,
      error: 'usage limit reached',
    });

    expect(cleanupStaleRateLimitPauseFile(specDir, now)).toBe(false);
    expect(pauseFileExists(specDir)).toBe(true);
  });

  it('removes expired reset timestamps and keeps future reset timestamps', () => {
    const specDir = makeSpecDir();
    const now = Date.parse('2026-05-25T10:00:00.000Z');
    writePauseFile(specDir, {
      pausedAt: '2026-05-25T09:00:00.000Z',
      resetTimestamp: '2026-05-25T09:59:59.000Z',
      error: 'usage limit reached',
    });

    expect(cleanupStaleRateLimitPauseFile(specDir, now)).toBe(true);
    expect(pauseFileExists(specDir)).toBe(false);

    writePauseFile(specDir, {
      pausedAt: '2026-05-25T09:00:00.000Z',
      resetTimestamp: '2026-05-25T10:30:00.000Z',
      error: 'usage limit reached',
    });

    expect(cleanupStaleRateLimitPauseFile(specDir, now)).toBe(false);
    expect(pauseFileExists(specDir)).toBe(true);
  });
});
