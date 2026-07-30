import { Text } from 'ink';
import type { FC } from 'react';
import { useMessages } from './i18n-context';
import { theme } from './theme';

/** The single-session lifecycle confirmations (both act on the selected session). */
export type ConfirmKind = 'merge' | 'discard';

/**
 * Props are a discriminated union so the counts can't drift from the kind: a
 * `resumeAll` line must state how many sessions it will restart (and how many of
 * those need a login first), and the lifecycle kinds have no counts at all.
 */
export type ConfirmPromptProps =
  | { kind: ConfirmKind; busy: boolean }
  | { kind: 'resumeAll'; busy: boolean; count: number; authCount: number };

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
      ? m.action.resumeAllPrompt(props.count, props.authCount)
      : props.kind === 'merge'
        ? m.action.mergePrompt
        : m.action.discardPrompt;
  return (
    <Text>
      {prompt} {m.action.confirmRun} <Text color={theme.yes}>y</Text> /{' '}
      <Text color={theme.no}>n</Text>
      {props.busy ? <Text dimColor> {m.action.busySuffix}</Text> : null}
    </Text>
  );
};
