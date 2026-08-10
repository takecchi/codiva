import { mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
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

  // issue #110: 一時リポジトリにも `~/.gitconfig` は効くので、テスト結果が開発者の
  // 設定（`commit.gpgSign` / `core.hooksPath` …）に依存していた。番人は
  // `tests/setup-git-config.ts`（グローバル / システム設定を無効化する setupFiles）。
  it('グローバル / システムの git 設定を継承しない', async () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(process.env.GIT_CONFIG_SYSTEM).toBe(devNull);
    dir = await mkdtemp(join(tmpdir(), 'codiva-git-'));
    await git(dir, ['init', '-b', 'main']);
    await expect(git(dir, ['config', '--global', '--list'])).resolves.toBe('');
    await expect(git(dir, ['config', '--system', '--list'])).resolves.toBe('');
  });

  it('throws GitError with stderr on failure', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codiva-git-'));
    await expect(git(dir, ['rev-parse', 'HEAD'])).rejects.toBeInstanceOf(GitError);
    await expect(git(dir, ['not-a-command'])).rejects.toThrow(/git not-a-command failed/);
  });
});
