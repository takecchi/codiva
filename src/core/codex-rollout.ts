/**
 * Codex の rollout ファイル（`$CODEX_HOME/sessions/<年>/<月>/<日>/rollout-<時刻>-<thread_id>.jsonl`）
 * から**実際に動いたモデル**を読み取るための純関数。読み出しの I/O は
 * `utils/codex.ts` の `resolveCodexRolloutModel`。
 *
 * なぜここまでするのか: `codex exec --json` の stdout は**モデル名をひとことも運ばない**
 * （実測 codex-cli 0.147.0 — `thread.started` / `turn.started` / `turn.completed` の
 * どれにも無い。`__fixtures__/codex-basic.jsonl` を参照）。Claude の `system/init` に
 * 当たるものが無いので、`--model` を明示していないセッションは解決済みモデルが
 * 分からず、一覧のモデル欄が空のままだった。
 *
 * `codex debug models` にも既定を示す印は無く、`codex doctor --json` は
 * `model = "<default>"` としか答えない。**唯一 CLI が解決結果を書き残すのが
 * rollout の `turn_context`** で、`-m` を渡さない実行でも解決済みの slug
 * （実測 `gpt-5.6-sol`）が入る。だからここを読む。
 *
 * カタログの先頭（priority 1）を既定とみなす手もあるが、`~/.codex/config.toml` で
 * `model` を設定しているユーザーに**嘘のモデル名**を出すことになるので採らない。
 */

/** rollout の 1 行（読む項目だけ。増えても落ちない）。 */
interface CodexRolloutLine {
  type?: unknown;
  payload?: unknown;
}

/**
 * ファイル名がこのスレッドの rollout か。
 *
 * 名前は `rollout-<ISO 風の時刻>-<thread_id>.jsonl` で、`thread_id` は
 * `thread.started` が運ぶ UUID そのもの。時刻部分は**ローカル時刻**なので当てにせず、
 * 末尾の id だけで突き合わせる。
 */
export function isCodexRolloutFile(fileName: string, threadId: string): boolean {
  return (
    threadId.length > 0 &&
    fileName.startsWith('rollout-') &&
    fileName.endsWith(`-${threadId}.jsonl`)
  );
}

/**
 * rollout の 1 行から `turn_context.model` を取り出す（それ以外の行は undefined）。
 *
 * `session_meta` は `model_provider`（`"openai"`）しか持たず**モデル slug は無い**ので、
 * ターンごとに書かれる `turn_context` が唯一の出所になる。
 */
export function codexRolloutModel(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const line = value as CodexRolloutLine;
  if (line.type !== 'turn_context' || !line.payload || typeof line.payload !== 'object') {
    return undefined;
  }
  const model = (line.payload as { model?: unknown }).model;
  return typeof model === 'string' && model.trim().length > 0 ? model : undefined;
}

/**
 * 渡されたテキスト（rollout の一部）から解決済みモデルを拾う。
 *
 * **渡された範囲で最後に見つかったものを採る**。`codex exec resume` は同じファイルへ
 * 追記していくので、後の `turn_context` のほうが新しい。
 *
 * ただし呼び出し側（`resolveCodexRolloutModel`）が渡すのは**ファイルの先頭だけ**なので、
 * 「セッション全体で最後」ではなく「読んだ範囲で最後」であることに注意。これで足りるのは、
 * 途中でモデルが変わるのは `/model` で明示選択したときだけで、**そのときはそもそも
 * 問い合わせをしない**（明示指定の値を Session が直接表示する）ため。
 *
 * 壊れた行・読み込み上限で切れた最終行は黙って捨てる（ここは best-effort の表示用で、
 * 読めなければモデル欄が空のままになるだけ）。
 */
export function codexRolloutModelFromText(text: string): string | undefined {
  let found: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 読み込み上限で切れた最終行など。次の行へ進む。
      continue;
    }
    found = codexRolloutModel(parsed) ?? found;
  }
  return found;
}
