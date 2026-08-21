import { isQuestion, type PermissionPolicy } from './session';

/**
 * Global tool-approval mode, toggled with shift+tab (à la Claude Code).
 * - `auto`: run every tool automatically (only AskUserQuestion pauses).
 * - `confirm`: pause on every tool for an explicit allow/deny.
 * The mode is read at each tool call, so toggling affects live sessions too.
 */
export type RunMode = 'auto' | 'confirm';

/**
 * Build the default permission policy from a live `getMode` accessor. Reading the
 * mode at call time means a shift+tab toggle takes effect on already-running
 * sessions. 質問は常にユーザーへ上げる — それ*が*「ユーザーに聞く」経路なので、
 * `auto` で自動 allow すると**空の回答で承諾を返して質問が黙って消える**。
 * 判定は `kind`（アダプタが正規化した種別）で行う: ツール名は provider ごとに違い、
 * Claude の `AskUserQuestion` だけを見ていたので Grok の `_x.ai/ask_user_question` が
 * 既定モードでは一度もダイアログに出ていなかった。
 */
export function createModePolicy(getMode: () => RunMode): PermissionPolicy {
  return (toolName, _input, kind) => {
    if (isQuestion(toolName, kind)) {
      return 'ask';
    }
    return getMode() === 'auto' ? 'allow' : 'ask';
  };
}
