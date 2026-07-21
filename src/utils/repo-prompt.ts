import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { toRepoPrompt } from '@/core';

/**
 * リポジトリ単位の追加指示ファイルの薄い I/O ラッパ。純粋な正規化は core の
 * `toRepoPrompt()` に委譲し、ここはファイル読み込みだけを担う（規約: architecture.md）。
 *
 * 置き場所は `<repo>/.codiva/prompt.md`（worktrees / state.json と同じ `.codiva/` 配下）。
 * 「終わったら PR を出す」等、リポジトリ固有のワークフロー指示をチームで共有できる。
 */
export function defaultRepoPromptPath(repoRoot: string): string {
  return join(repoRoot, '.codiva', 'prompt.md');
}

/**
 * リポジトリの追加指示を読み込む。ファイル無し・空はいずれも `undefined`（指示なし）へ
 * フォールバックし、決して throw しない（設定ミスで TUI を落とさない）。
 */
export async function loadRepoPrompt(
  repoRoot: string,
  path: string = defaultRepoPromptPath(repoRoot),
): Promise<string | undefined> {
  try {
    return toRepoPrompt(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * リポジトリの追加指示を書き出す（/prompt での編集を永続化）。正規化は core の
 * `toRepoPrompt()` に委譲し、内容があれば `.codiva/prompt.md` へ（ディレクトリごと）
 * 作成、空（指示なし）ならファイルを削除して `.codiva/` を汚さない。
 * 末尾に改行を付けて保存する（エディタ/CLI で開いたときの体裁）。
 */
export async function saveRepoPrompt(
  repoRoot: string,
  raw: string,
  path: string = defaultRepoPromptPath(repoRoot),
): Promise<void> {
  const normalized = toRepoPrompt(raw);
  if (normalized === undefined) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${normalized}\n`, 'utf8');
}
