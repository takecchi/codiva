import { isQuestion, type PermissionPolicy } from './session';

/**
 * Global tool-approval mode, toggled with shift+tab (à la Claude Code).
 * - `auto`: run every tool automatically (only AskUserQuestion pauses).
 * - `smart`: ask an external risk evaluator per tool call; only what it judges
 *   routine runs automatically, everything else pauses (`core/permission-evaluator.ts`).
 * - `confirm`: pause on every tool for an explicit allow/deny.
 * The mode is read at each tool call, so toggling affects live sessions too.
 */
export type RunMode = 'auto' | 'smart' | 'confirm';

/**
 * shift+tab の巡回順。**`smart` は評価器が配線されているときだけ**（設定で
 * 明示的に有効化 + API キーあり）輪に入る — 未設定のユーザーには選択肢自体が
 * 現れず、既存の auto ⇄ confirm がそのまま残る（issue #139「Jev 未設定時は
 * 現在の挙動を変えない」）。純粋。
 *
 * `smart` から始まっているのに評価器が無い（設定を外して再起動した等）場合も
 * 輪から抜けられるよう、現在値が `smart` なら次は `confirm` にする。
 */
export function nextRunMode(mode: RunMode, smartAvailable: boolean): RunMode {
  if (mode === 'auto') {
    return smartAvailable ? 'smart' : 'confirm';
  }
  if (mode === 'smart') {
    return 'confirm';
  }
  return 'auto';
}

/**
 * Build the default permission policy from a live `getMode` accessor. Reading the
 * mode at call time means a shift+tab toggle takes effect on already-running
 * sessions. 質問は常にユーザーへ上げる — それ*が*「ユーザーに聞く」経路なので、
 * `auto` で自動 allow すると**空の回答で承諾を返して質問が黙って消える**。
 * 判定は `kind`（アダプタが正規化した種別）で行う: ツール名は provider ごとに違い、
 * Claude の `AskUserQuestion` だけを見ていたので Grok の `_x.ai/ask_user_question` が
 * 既定モードでは一度もダイアログに出ていなかった。
 *
 * `smart` は**ここでは決めない**（`'evaluate'` を返して保留する）。判定は
 * ネットワーク I/O を伴うので、同期のポリシーに押し込むと全 provider の経路が
 * async 化する。`Session` が `'evaluate'` を受けたときだけ非同期の評価器へ降りる
 * （`core/permission-evaluator.ts`）。
 */
export function createModePolicy(getMode: () => RunMode): PermissionPolicy {
  return (toolName, _input, kind) => {
    if (isQuestion(toolName, kind)) {
      return 'ask';
    }
    const mode = getMode();
    if (mode === 'auto') {
      return 'allow';
    }
    return mode === 'smart' ? 'evaluate' : 'ask';
  };
}
