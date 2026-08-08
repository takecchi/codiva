import { Text } from 'ink';
import type { FC } from 'react';
import { DEFAULT_AGENT_LABEL } from '@/core';
import { useMessages } from './i18n-context';
import { theme } from './theme';

/** The single-session lifecycle confirmations (all act on the selected session). */
export type ConfirmKind = 'merge' | 'discard' | 'remove';

/**
 * Props are a discriminated union so the counts can't drift from the kind: a
 * `resumeAll` line must state how many sessions it will restart (and how many of
 * those need a login first), a `clear` line how many rows it will drop, and the
 * single-session lifecycle kinds have no counts at all.
 */
export type ConfirmPromptProps =
  | { kind: ConfirmKind; busy: boolean }
  | { kind: 'clear'; busy: boolean; count: number }
  | { kind: 'resumeAll'; busy: boolean; count: number; authCount: number }
  | { kind: 'recoverAll'; busy: boolean; syncCount: number; ciCount: number };

/**
 * The confirm line — `<prompt> Proceed? y / n [busy]`. Just the text row (no
 * frame); the caller wraps it in a DialogBox. Shared by the list (its own confirm
 * box) and the detail view (inside its actions panel) so the two never drift in
 * wording or color.
 *
 * `resumeAll` fans out to every cut-off session at once, so unlike the one-key
 * single resume it asks first — a stray Ctrl+A must not spend money.
 */
export const ConfirmPrompt: FC<ConfirmPromptProps> = (props) => {
  const m = useMessages();
  // 判別は `props.kind` を直接、かつ `resumeAll` を先に見る（分割代入すると narrowing が
  // 切れ、lifecycle 側を先に除外する書き方では count/authCount を読めない）。
  const prompt =
    props.kind === 'resumeAll'
      ? m.action.resumeAllPrompt(DEFAULT_AGENT_LABEL, props.count, props.authCount)
      : props.kind === 'recoverAll'
        ? m.recover.allPrompt(props.syncCount, props.ciCount)
        : props.kind === 'clear'
          ? m.action.clearPrompt(props.count)
          : props.kind === 'merge'
            ? m.action.mergePrompt
            : props.kind === 'discard'
              ? m.action.discardPrompt
              : m.action.removePrompt;
  return (
    <Text>
      {prompt} {m.action.confirmRun} <Text color={theme.yes}>y</Text> /{' '}
      <Text color={theme.no}>n</Text>
      {props.busy ? <Text dimColor> {m.action.busySuffix}</Text> : null}
    </Text>
  );
};
