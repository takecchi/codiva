import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedState } from '@/core';
import { defaultStatePath, loadState } from '@/utils';
import { createPersistController, type PersistController } from './persist-controller';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codiva-persist-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stateWith(id: string): PersistedState {
  return {
    version: 1,
    sessions: [
      {
        id,
        title: id,
        prompt: 'do it',
        slug: id,
        branch: `codiva/${id}`,
        worktreePath: `/tmp/wt/${id}`,
        base: 'main',
        sdkSessionId: `sdk-${id}`,
        status: 'completed',
        startedAt: 0,
        todos: [],
      },
    ],
  };
}

async function savedIds(path: string): Promise<string[]> {
  return (await loadState(path)).sessions.map((s) => s.id);
}

/** A path that every write fails on (renaming a file onto a non-empty directory). */
async function blockedPath(): Promise<string> {
  const path = join(dir, 'blocked');
  await mkdir(join(path, 'child'), { recursive: true });
  return path;
}

describe('createPersistController', () => {
  it('writes the snapshot as of the write, not as of scheduling', async () => {
    const path = defaultStatePath(dir);
    let current = stateWith('old');
    const persist = createPersistController(() => current, path);
    persist.schedule();
    current = stateWith('new');
    await persist.flushAsync();
    expect(await savedIds(path)).toEqual(['new']);
  });

  it('repairs the file when a synchronous flush lands mid-write', async () => {
    const path = defaultStatePath(dir);
    let calls = 0;
    let persist: PersistController | undefined;
    const snapshot = (): PersistedState => {
      if (calls++ === 0) {
        // The kill path fires while this (already stale) write is still in flight.
        queueMicrotask(() => persist?.flushSync());
        return stateWith('old');
      }
      return stateWith('newest');
    };
    persist = createPersistController(snapshot, path);
    await persist.flushAsync();
    expect(await savedIds(path)).toEqual(['newest']);
  });

  it('keeps saving after a failed write', async () => {
    const blocked = await blockedPath();
    const persist = createPersistController(() => stateWith('a'), blocked);
    await expect(persist.flushAsync()).resolves.toBeUndefined();
    await expect(persist.flushAsync()).resolves.toBeUndefined();
    const path = defaultStatePath(dir);
    const ok = createPersistController(() => stateWith('b'), path);
    await ok.flushAsync();
    expect(await savedIds(path)).toEqual(['b']);
  });

  it('flushSync swallows write failures', async () => {
    const persist = createPersistController(() => stateWith('a'), await blockedPath());
    expect(() => persist.flushSync()).not.toThrow();
  });
});
