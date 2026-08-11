import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CodivaConfig, toConfig } from '@/core';

/**
 * ユーザー設定ファイルの薄い I/O ラッパ。純粋な検証変換は core の `toConfig()` に委譲し、
 * ここはファイルの読み書きだけを担う（規約: architecture.md / coding-rules.md）。
 *
 * 保存先は `~/.codiva/config.json`（Claude Code の `~/.claude/` と同じ流儀のユーザーグローバル）。
 * テスト容易性のため各関数はパスを引数で受け取れる（既定は上記）。
 */
export function defaultConfigPath(): string {
  return join(homedir(), '.codiva', 'config.json');
}

/** 設定を読み込む。ファイル無し・JSON 不正はいずれも空設定にフォールバックする（クラッシュさせない）。 */
export async function loadConfig(path: string = defaultConfigPath()): Promise<CodivaConfig> {
  try {
    const raw = await readFile(path, 'utf8');
    return toConfig(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * 設定を書き出す。親ディレクトリが無ければ作成する。
 *
 * 書き込みは**一時ファイル → rename** で行う（同一ディレクトリなので rename は atomic）。
 * 直接 `writeFile` で全置換すると、途中で落ちた／別プロセスの codiva と重なったときに
 * 設定ファイルが切り詰められた JSON のまま残り、次回起動で丸ごと既定値へ戻る
 * （`loadConfig` は壊れた JSON を空設定にフォールバックする）。一時ファイル名に pid を
 * 入れるのは、複数プロセスが同じ一時ファイルを取り合わないため。
 */
export async function saveConfig(
  config: CodivaConfig,
  path: string = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    // 失敗しても一時ファイルを残さない（後始末の失敗は握り潰す）。
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
