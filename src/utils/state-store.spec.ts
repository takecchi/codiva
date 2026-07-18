import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyPersistedState, type PersistedState } from '@/core';
import {
  defaultStatePath,
  loadState,
  pruneMissingWorktrees,
  saveState,
  saveStateSync,
} from '@/utils/state-store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codiva-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleState(worktreePath: string): PersistedState {
  return {
    version: 1,
    sessions: [
      {
        id: '1',
        title: 'task',
        prompt: 'do it',
        slug: 'task',
        branch: 'codiva/task',
        worktreePath,
        base: 'main',
        sdkSessionId: 'sdk-1',
        status: 'completed',
        startedAt: 0,
        todos: [],
      },
    ],
  };
}

describe('defaultStatePath', () => {
  it('is <repo>/.codiva/state.json', () => {
    expect(defaultStatePath('/repo')).toBe('/repo/.codiva/state.json');
  });
});

describe('saveState / loadState', () => {
  it('round-trips through disk, creating .codiva/ as needed', async () => {
    const path = defaultStatePath(dir);
    const state = sampleState('/tmp/wt/task');
    await saveState(state, path);
    expect(await loadState(path)).toEqual(state);
  });

  it('returns empty state when the file is missing', async () => {
    expect(await loadState(join(dir, 'nope.json'))).toEqual(emptyPersistedState());
  });

  it('returns empty state when the file is corrupt JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ not json', 'utf8');
    expect(await loadState(path)).toEqual(emptyPersistedState());
  });

  it('saveStateSync writes synchronously and is readable back', async () => {
    const path = defaultStatePath(dir);
    const state = sampleState('/tmp/wt/task');
    saveStateSync(state, path);
    expect(await loadState(path)).toEqual(state);
  });
});

describe('pruneMissingWorktrees', () => {
  it('keeps sessions whose worktree exists and drops the rest', async () => {
    const present = join(dir, 'present');
    await mkdir(present);
    const state: PersistedState = {
      version: 1,
      sessions: [...sampleState(present).sessions, ...sampleState(join(dir, 'gone')).sessions],
    };
    const pruned = pruneMissingWorktrees(state);
    expect(pruned.sessions).toHaveLength(1);
    expect(pruned.sessions[0]?.worktreePath).toBe(present);
  });
});
