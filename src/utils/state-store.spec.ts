import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

  it('serializes concurrent writes so the last caller wins', async () => {
    const path = defaultStatePath(dir);
    const first = sampleState('/tmp/wt/first');
    const last = sampleState('/tmp/wt/last');
    // Both start before either finishes: the earlier (stale) write must not land last.
    await Promise.all([saveState(first, path), saveState(last, path)]);
    expect(await loadState(path)).toEqual(last);
  });

  it('leaves no temp files behind', async () => {
    const path = defaultStatePath(dir);
    await saveState(sampleState('/tmp/wt/a'), path);
    saveStateSync(sampleState('/tmp/wt/b'), path);
    expect(await readdir(join(dir, '.codiva'))).toEqual(['state.json']);
  });

  it('keeps the previous file intact when a write fails', async () => {
    const path = defaultStatePath(dir);
    const good = sampleState('/tmp/wt/good');
    await saveState(good, path);
    // A directory in the way makes the rename fail after the temp file is written.
    await mkdir(join(dir, 'blocked', 'child'), { recursive: true });
    const blocked = join(dir, 'blocked');
    await expect(saveState(sampleState('/tmp/wt/bad'), blocked)).rejects.toThrow();
    expect(() => saveStateSync(sampleState('/tmp/wt/bad'), blocked)).toThrow();
    expect((await readdir(dir)).sort()).toEqual(['.codiva', 'blocked']);
    expect(await loadState(path)).toEqual(good);
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
