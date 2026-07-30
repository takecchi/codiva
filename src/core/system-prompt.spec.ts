import { describe, expect, it } from 'vitest';
import { composeSystemPrompt, SHARED_IGNORED_FILES_NOTICE } from './system-prompt';
import type { IgnoredFilesMode } from './worktree';

describe('composeSystemPrompt', () => {
  const REPO = 'Always run npm test';

  it.each<[string, { ignoredFiles?: IgnoredFilesMode; repoPrompt?: string }, string | undefined]>([
    ['nothing configured', {}, undefined],
    ['repo prompt only', { repoPrompt: REPO }, REPO],
    ['copy mode has no notice', { ignoredFiles: 'copy', repoPrompt: REPO }, REPO],
    ['none mode has no notice', { ignoredFiles: 'none', repoPrompt: REPO }, REPO],
    ['unknown mode has no notice', { ignoredFiles: undefined, repoPrompt: REPO }, REPO],
    ['symlink mode alone', { ignoredFiles: 'symlink' }, SHARED_IGNORED_FILES_NOTICE],
    [
      'symlink mode + repo prompt',
      { ignoredFiles: 'symlink', repoPrompt: REPO },
      `${SHARED_IGNORED_FILES_NOTICE}\n\n${REPO}`,
    ],
  ])('%s', (_label, parts, expected) => {
    expect(composeSystemPrompt(parts)).toBe(expected);
  });

  it('treats an empty repo prompt as absent (systemPrompt stays omitted)', () => {
    expect(composeSystemPrompt({ repoPrompt: '' })).toBeUndefined();
    expect(composeSystemPrompt({ ignoredFiles: 'symlink', repoPrompt: '' })).toBe(
      SHARED_IGNORED_FILES_NOTICE,
    );
  });

  describe('SHARED_IGNORED_FILES_NOTICE', () => {
    // 注意書きの「要点」が落ちたら気付けるようにする。言い回しの推敲で落ちないよう、
    // 文ではなく意味のアンカー（コマンド名・キーワード）だけを見る。
    it.each([
      ['says the ignored paths are symlinked', /symlink/i],
      ['says the targets are shared with the main checkout', /shared with the main checkout/],
      ['tells how to detect a symlink', /test -L/],
      ['shows how to detach without touching the target', /readlink/],
      ['warns that removing through the link destroys the original', /rm -rf/],
      ['warns about the trailing slash specifically', /trailing slash/],
      ['says reading is fine', /[Rr]eading[^.]*safe/],
      ['says to do nothing when the task never writes', /ignore all of this|nothing to do/],
      ['warns that the links are not covered by gitignore', /git add -A/],
    ])('%s', (_label, pattern) => {
      expect(SHARED_IGNORED_FILES_NOTICE).toMatch(pattern);
    });

    it('does not tell the agent to dereference nested symlinks (cp -L breaks stores)', () => {
      expect(SHARED_IGNORED_FILES_NOTICE).not.toMatch(/cp -[A-Za-z]*L/);
    });

    // 言語・ツールチェイン非依存に保つ（判定は名前ではなく `test -L` の結果でさせる）。
    // `$target` はシェル変数なので `\btarget\/` ではなく個別のディレクトリ名で見る。
    it('is project agnostic (no hardcoded toolchain paths)', () => {
      expect(SHARED_IGNORED_FILES_NOTICE).not.toMatch(
        /node_modules|\bdist\b|\.venv|Cargo|Gemfile|__pycache__/,
      );
    });
  });
});
