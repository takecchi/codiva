/**
 * 入力欄の履歴（shell / readline の ↑↓ と同じ仕組み）の純粋モデル。
 *
 * 「送信した指示をもう一度出す」「打ち間違えた長い指示を呼び戻して直す」ための機能で、
 * 状態は「送信済みテキストの列 + いま何番目を呼び出しているか + 辿り始めたときの
 * 書きかけ」の 3 つだけ。UI（`ui/hooks.ts` の `useInputHistory`）はここへ委譲し、
 * キー入力の対応付けだけを持つ。
 *
 * 位置 `index` は `entries.length` を「呼び出していない（= 書きかけを編集中）」という
 * 番兵に使う。`draft` は ↑ で辿り始めた瞬間の書きかけで、↓ で最新を越えたときに戻す先。
 */

/** 覚えておく件数の上限（超えたら古い方から捨てる）。 */
export const INPUT_HISTORY_LIMIT = 50;

export interface InputHistory {
  /** 送信済みテキスト（古い順・末尾が最新）。 */
  readonly entries: readonly string[];
  /** 呼び出し位置。`entries.length` は「呼び出していない」を表す番兵。 */
  readonly index: number;
  /** 辿り始めたときの書きかけ（↓ で最新を越えると復帰する）。 */
  readonly draft: string;
}

/** 呼び出したテキストと、それを反映した履歴。呼び出せないときは undefined を返す。 */
export interface InputRecall {
  readonly history: InputHistory;
  readonly value: string;
}

export function emptyInputHistory(): InputHistory {
  return { entries: [], index: 0, draft: '' };
}

/** いま履歴を辿っている最中か（= 書きかけではなく過去の入力を表示している）。 */
export function isBrowsingHistory(history: InputHistory): boolean {
  return history.index < history.entries.length;
}

/** 辿るのをやめて書きかけモードへ戻す（送信・履歴追加のたびに通る）。 */
export function resetHistoryBrowse(history: InputHistory): InputHistory {
  return history.index === history.entries.length && history.draft === ''
    ? history
    : { entries: history.entries, index: history.entries.length, draft: '' };
}

/**
 * 送信されたテキストを履歴へ積む。空文字は積まない（shell と同じ）。直前と同じ
 * テキストも積まない — 同じ指示を続けて投げたときに ↑ の 1 押しが無駄になるため。
 * どちらの場合も呼び出し位置はリセットする（送信後の ↑ は必ず最新から始まる）。
 */
export function recordInput(history: InputHistory, text: string): InputHistory {
  const value = text.trim();
  if (value === '') {
    return resetHistoryBrowse(history);
  }
  const entries =
    history.entries[history.entries.length - 1] === value
      ? history.entries
      : [...history.entries, value].slice(-INPUT_HISTORY_LIMIT);
  return { entries, index: entries.length, draft: '' };
}

/**
 * ↑: 1つ前（古い方）の入力を呼び出す。辿り始めるときは `current`（いまの書きかけ）を
 * `draft` に保存するので、↓ で戻ってこられる。履歴が無い / 最古まで来ているときは
 * undefined を返し、呼び出し側は通常のキャレット移動へ委ねる。
 */
export function recallPrev(history: InputHistory, current: string): InputRecall | undefined {
  if (history.index === 0) {
    return undefined; // 履歴なし、または最古を表示中
  }
  const index = history.index - 1;
  const value = history.entries[index];
  if (value === undefined) {
    return undefined;
  }
  const draft = isBrowsingHistory(history) ? history.draft : current;
  return { history: { entries: history.entries, index, draft }, value };
}

/**
 * ↓: 1つ後（新しい方）の入力へ。最新を越えたら辿り始めたときの書きかけへ戻る
 * （= 履歴を覗いただけで書きかけを失わない）。辿っていないときは undefined。
 */
export function recallNext(history: InputHistory): InputRecall | undefined {
  if (!isBrowsingHistory(history)) {
    return undefined;
  }
  const index = history.index + 1;
  if (index >= history.entries.length) {
    return { history: resetHistoryBrowse(history), value: history.draft };
  }
  const value = history.entries[index];
  return value === undefined
    ? undefined
    : { history: { entries: history.entries, index, draft: history.draft }, value };
}
