import { Box, Text } from 'ink';
import type { FC } from 'react';
import { allPrs, otherPrs, type PrLookupState, type PrRef, type PrStatus } from '@/core';
import { useMessages } from './i18n-context';
import { glyph, statusColor, theme } from './theme';

/**
 * PR の見せ方（一覧の行末セル / 詳細ビューの一覧行）。両ビューで同じグリフ・同じ色に
 * するため、`prStatusBadge` ごとここに置く（`.tsx` に生 ANSI 名は書かず `theme.ts` 経由）。
 */

/**
 * Glyph + color shown before `#<number>`. The cell is one column wide, so a single
 * glyph has to carry both the merge state and the CI state; the priority is "what
 * would make me look": merged → failing checks → running checks → conflict → clean.
 * GitHub-conventional colors (merged violet, clean green, broken red, running amber).
 * `unknown` (GitHub still computing, no checks configured) shows no glyph so the row
 * stays quiet until the state is real.
 */
export function prStatusBadge(status: PrStatus): { char: string; color: string } | undefined {
  if (status.mergeStatus === 'merged') {
    return { char: glyph.merged, color: statusColor.external };
  }
  if (status.checks === 'failing') {
    return { char: glyph.conflicting, color: statusColor.failed };
  }
  if (status.checks === 'pending') {
    return { char: glyph.checksPending, color: statusColor.awaitingPermission };
  }
  if (status.mergeStatus === 'conflicting') {
    return { char: glyph.conflicting, color: statusColor.failed };
  }
  if (status.mergeStatus === 'mergeable') {
    return { char: glyph.mergeable, color: statusColor.completed };
  }
  return undefined;
}

/**
 * Stand-in for the status glyph while the status itself isn't known: `⋯` for a lookup
 * in flight, `?` for one that couldn't answer (rate limit / offline / not logged in).
 *
 * Shown next to a known `#<n>` too, not just in place of one. A number with nothing
 * beside it reads as "this PR has no state worth showing", so a PR whose state we
 * never manage to fetch looked identical to a quiet, healthy one — with no hint that
 * anything was still pending.
 */
const LookupMark: FC<{ lookup?: PrLookupState; pad?: boolean }> = ({ lookup, pad }) => {
  const tail = pad ? ' ' : '';
  if (lookup === 'loading') {
    return (
      <Text dimColor>
        {glyph.prLoading}
        {tail}
      </Text>
    );
  }
  if (lookup === 'error') {
    return (
      <Text color={theme.warn}>
        {glyph.prUnknown}
        {tail}
      </Text>
    );
  }
  return null;
};

/**
 * The list row's trailing PR cell, drawn from whatever is known so far — the two
 * halves arrive (and expire) independently:
 *
 *  - `pr` (number/url) is stable and cached across restarts, so `#<n>` renders as
 *    soon as it's known and never waits on the status.
 *  - `status` is polled; until it lands the number stands alone without a glyph.
 *
 * An *empty* cell therefore means exactly one thing — "this branch has no PR" — and
 * the two "don't know yet" cases get their own marks: `⋯` while the first lookup is
 * in flight, `?` when the last one failed (rate limit / offline / not logged in).
 * A draft PR's number is dimmed (still underlined — it's clickable either way).
 *
 * 1 セッションが複数の PR を出すことがある（セッション自身が別ブランチで
 * `gh pr create` した）。そのときは代表の番号に続けて `+n` を出す — 番号を全部並べると
 * 幅可変の title/branch を圧迫し、桁数しだいで行末が崩れるため。全件は詳細ビューに出す。
 */
export const PrCell: FC<{
  pr?: PrRef;
  status?: PrStatus;
  lookup?: PrLookupState;
  /** 代表以外の PR の件数（0 なら従来どおり番号だけ）。 */
  others?: number;
}> = ({ pr, status, lookup, others = 0 }) => {
  if (pr) {
    const badge = status ? prStatusBadge(status) : undefined;
    return (
      // `truncate-end` は必須。折り返すと**行が 2 行になり**、`rowLineAtPoint`（1 セッション
      // = 1 行が前提）以降の行のクリックが全部ズレる。狭い端末で列が縮んだときは
      // 番号が切れるほうがまし（他の列も同じ方針）。
      <Text wrap="truncate-end">
        {badge ? (
          <Text color={badge.color}>{badge.char} </Text>
        ) : (
          <LookupMark lookup={lookup} pad />
        )}
        <Text color={status?.isDraft ? theme.dim : theme.accent} underline>
          #{pr.number}
        </Text>
        {others > 0 ? <Text dimColor> +{others}</Text> : null}
      </Text>
    );
  }
  return <LookupMark lookup={lookup} />;
};

/** 詳細ビューの 1 行に収める PR の区切り（数字が続くので中黒ではなく点で分ける）。 */
const PR_SEPARATOR = ' · ';

/**
 * 詳細ビューの PR 行。**複数 PR のときだけ**出す（1 本なら一覧の行末セルで足りるし、
 * ログの縦幅はできるだけログに使いたい）。番号は 1 行に並べる — セッションが出した PR は
 * 高々数件で、行を分けるとそのぶんログが削れるため。
 *
 * グリフが付くのは代表（セッションブランチの PR）だけ。それ以外は codiva が追跡していない
 * ＝ 状態を知らないので、何も付けずに番号だけ出す（知らない状態を緑や赤で嘘をつかない）。
 */
export const PrSummary: FC<{
  state: { pr?: PrRef; extraPrs?: readonly PrRef[]; prStatus?: PrStatus };
}> = ({ state }) => {
  const m = useMessages();
  const prs = allPrs(state);
  if (otherPrs(state).length === 0) {
    return null;
  }
  const badge = state.pr && state.prStatus ? prStatusBadge(state.prStatus) : undefined;
  // 1 つの <Text> の中に入れ子で色を付ける（row の Box に <Text> を並べない）。Yoga は
  // 横並びの子を**両方とも縮める**ので、狭い端末で見出しも番号も途中で切れてしまう。
  // 入れ子なら折返し/切り詰めの単位が行全体になる（ink-components.md）。
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        <Text dimColor>{m.detail.prsLabel(prs.length)} </Text>
        {prs.map((pr, i) => (
          <Text key={pr.url}>
            {i > 0 ? <Text dimColor>{PR_SEPARATOR}</Text> : null}
            {i === 0 && badge ? <Text color={badge.color}>{badge.char} </Text> : null}
            <Text color={theme.accent}>#{pr.number}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
};
