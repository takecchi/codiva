/**
 * リポジトリ単位の追加指示（`.codiva/prompt.md`）を正規化する純関数。
 * 生ファイル内容 → セッションへ注入する文字列（または「無し」）への変換をここに閉じ込める。
 *
 * codiva はセッション起動時、対象リポジトリの `.codiva/prompt.md` を読み、
 * SDK の systemPrompt として渡す（`core/session.ts` の `consume()`）。CLAUDE.md は
 * `settingSources: ['project']` 経由で別途注入されるので、これはそれへの上乗せになる。
 */

/** 先頭 BOM。UTF-8 で保存されたファイルに紛れ込むと不可視のまま systemPrompt を汚す。 */
const BOM = '﻿';

/**
 * 生のファイル内容を追加 systemPrompt へ変換する。空・空白のみは「指示なし」として
 * `undefined` を返す（呼び出し側は systemPrompt を渡さず現挙動を維持する）。
 * 内容は著者管理下なので長さ制限や再整形はせず、BOM 除去と前後空白のトリムのみ行う。
 */
export function toRepoPrompt(raw: string): string | undefined {
  const trimmed = (raw.startsWith(BOM) ? raw.slice(BOM.length) : raw).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
