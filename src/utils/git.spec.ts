import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitError, git } from '@/utils/git';

describe('git', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns trimmed stdout on success', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-git-'));
    await git(dir, ['init', '-b', 'main']);
    const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
    expect(branch).toBe('main');
  });

  it('throws GitError with stderr on failure', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-git-'));
    await expect(git(dir, ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitError);
    await expect(git(dir, ['not-a-command'])).rejects.toThrow(/git not-a-command failed/);
  });
});
