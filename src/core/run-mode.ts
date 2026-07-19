import type { PermissionPolicy } from './session';

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
 * sessions. AskUserQuestion always escalates — it *is* the ask-the-user channel.
 */
export function createModePolicy(getMode: () => RunMode): PermissionPolicy {
  return (toolName) => {
    if (toolName === 'AskUserQuestion') {
      return 'ask';
    }
    return getMode() === 'auto' ? 'allow' : 'ask';
  };
}
