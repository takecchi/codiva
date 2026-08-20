import stringWidth from 'string-width';
import { wrapDisplayLines } from './scroll';

/**
 * 選択リスト（AskUserQuestion の選択肢 / `/model` のモデル行）1 件のテキスト。
 * ラベルと、あれば補足の説明。どちらも長さの制限はない。
 */
export interface Choice {
  /** 選択肢の見出し（回答としてモデルへ返る文字列） */
  label: string;
  /** 補足説明（任意）。ラベルより深く字下げして続けて描く。 */
  description?: string;
}

/** 説明をラベルよりさらに字下げする量（セル）。ラベルと説明の境目を目で追うため。 */
export const CHOICE_DESCRIPTION_INDENT = 2;

/** {@link choiceLines} が返す 1 物理行。 */
export interface ChoiceDisplayLine {
  /** 安定した描画キー（`label:0` / `desc:1` …）。`DisplayLine` と同じ役割。 */
  key: string;
  /**
   * 描画する行の全文。1 行目は `prefix`（`❯ [x] ` 等）を含み、折返しの継続行は
   * prefix と同じ表示幅のインデントを含む（= そのまま 1 行として出せる）。
   */
  text: string;
  /** 説明の行（UI は dim で描く）。false ならラベルの行。 */
  description: boolean;
}

/**
 * 選択肢 1 件を、幅 `width` セルに収まる物理行へ展開する純関数。
 *
 * ラベルと説明を**同じ行に並べない**のが要点。1 行に詰めると Yoga が両方の
 * `<Text>` を縮めるため、長いラベル・長い説明のどちらも途中で切れて読めなくなる
 * （実際に起きた不具合）。行に分けて折返せば全文が必ず表示される。
 *
 * 幅は表示幅で数える（`wrapDisplayLines`）。CJK・絵文字は 2 セルなので、日本語の
 * 説明でも端末が折り返す位置と一致する。継続行は `prefix` の表示幅ぶん字下げして
 * ラベルの桁に揃える（`logLines` と同じ考え方）。
 */
export function choiceLines(choice: Choice, width: number, prefix: string): ChoiceDisplayLine[] {
  const lead = stringWidth(prefix);
  const indent = ' '.repeat(lead);
  const out: ChoiceDisplayLine[] = [];

  const labelWidth = Math.max(1, width - lead);
  const labelRows = wrapDisplayLines(choice.label, labelWidth);
  for (let i = 0; i < labelRows.length; i += 1) {
    out.push({
      key: `label:${i}`,
      text: (i === 0 ? prefix : indent) + labelRows[i],
      description: false,
    });
  }

  const description = choice.description?.trim();
  if (description) {
    const descIndent = indent + ' '.repeat(CHOICE_DESCRIPTION_INDENT);
    const descWidth = Math.max(1, width - lead - CHOICE_DESCRIPTION_INDENT);
    const rows = wrapDisplayLines(description, descWidth);
    for (let i = 0; i < rows.length; i += 1) {
      out.push({ key: `desc:${i}`, text: descIndent + rows[i], description: true });
    }
  }
  return out;
}

/**
 * 選択リスト 1 件ぶんの描画指定。**描画（`ChoiceRow`）と当たり判定（{@link choiceRowHeights}）で
 * 同じ配列を回す**ための型で、これが 1 件 = 何行かを決める唯一の入力になる。
 */
export interface ChoiceRowItem {
  choice: Choice;
  /** 1 行目の行頭（`❯ `, `❯ [x] ` 等）。表示幅ぶん折返し幅が減るので高さに影響する。 */
  prefix: string;
}

/**
 * 各件が占める物理行数（ラベルの折返し + 説明の行）。1 件 = 1 行**ではない**ので、
 * クリック位置から選択肢を逆算するにはこの配列が必要になる。
 *
 * 描画に渡すのと同じ `items` / `width` を通すこと。折返し幅が食い違うと行数が変わり、
 * 押した行と当たった選択肢がズレる（一覧の PR セルで幅を揃えているのと同じ理由）。
 */
export function choiceRowHeights(items: readonly ChoiceRowItem[], width: number): number[] {
  return items.map((item) => choiceLines(item.choice, width, item.prefix).length);
}

/**
 * 選択リストを高さ `cap` **行**のウィンドウに収めるための表示範囲。
 * `core/layout.ts` の {@link ListView} と同じ役割だが、**1 件 = 1 行ではない**
 * （ラベルの折返し + 説明）ので件数ではなく行数で詰める。
 */
export interface ChoiceView {
  /** 表示する最初の選択肢 index（含む） */
  start: number;
  /** 表示する最後の選択肢 index の次（含まない） */
  end: number;
  /** ウィンドウより上に隠れている件数 */
  hiddenAbove: number;
  /** ウィンドウより下に隠れている件数 */
  hiddenBelow: number;
  /** 上端に「↑ 他 N 件」インジケータ行を出すか */
  showAbove: boolean;
  /** 下端に「↓ 他 N 件」インジケータ行を出すか */
  showBelow: boolean;
}

/** カーソルの件を必ず含む、`budget` 行に収まる範囲（下端アンカー）。 */
function fitWindow(
  heights: readonly number[],
  cursor: number,
  budget: number,
): { start: number; end: number } {
  const total = heights.length;
  const sel = Math.max(0, Math.min(cursor, total - 1));
  let start = sel;
  let end = sel + 1;
  // カーソルの件だけは budget を超えても必ず入れる（選んでいるものが見えないと
  // 何を決めるのか分からない）。溢れるのは「1 件が可視域より高い」極端な場合だけ。
  let used = heights[sel] ?? 0;
  // 下端アンカー: まず上へ伸ばす（= カーソルを下端に置く）。`visibleLineRange` /
  // `listView` と同じ挙動にして、↓ でスクロールする感覚を全画面で揃える。
  while (start > 0 && used + (heights[start - 1] ?? 0) <= budget) {
    start -= 1;
    used += heights[start] ?? 0;
  }
  // 上に詰め切れなかったぶん（カーソルが先頭寄り）は下へ伸ばす。
  while (end < total && used + (heights[end] ?? 0) <= budget) {
    used += heights[end] ?? 0;
    end += 1;
  }
  return { start, end };
}

/**
 * 選択リスト（高さがバラバラな `heights` 行の並び）を `cap` 行に収める表示範囲を、
 * `cursor` の件を必ず見える位置に保ちながら求める純関数。溢れる端には
 * 「↑↓ 他 N 件」インジケータ用に 1 行を予約するので、描画行数（選択肢 +
 * インジケータ）は原則 `cap` 以下になる。
 *
 * これが無いと質問ダイアログは選択肢の数だけ縦に伸びる。ダイアログは
 * `flexShrink={0}` なので、伸びたぶんは**兄弟のログ領域**（`flexGrow`）から奪われ、
 * 低い端末では会話ログの可視行が 0 になって「質問の背景を読めないまま答える」ことに
 * なっていた（`core/layout.ts` の `dialogMaxRows`）。
 *
 * `listView` にある「隠れているのが 1 件だけならインジケータの席にその件を出す」
 * 最適化は入れていない。1 件が 1 行とは限らないので、席（1 行）に収まる保証がない。
 */
export function choiceView(heights: readonly number[], cursor: number, cap: number): ChoiceView {
  const total = heights.length;
  const c = Math.max(1, Math.floor(cap));
  const sum = heights.reduce((acc, rows) => acc + rows, 0);
  if (total === 0 || sum <= c) {
    return {
      start: 0,
      end: total,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
    };
  }
  // インジケータの予約でウィンドウが縮むと別の端が新たに溢れることがある（縮小は
  // 隠れ件数を増やすだけなので単調）。`listView` と同じく増やす方向にのみ更新して
  // 不動点まで反復する。
  let above = false;
  let below = false;
  let win = { start: 0, end: total };
  for (let i = 0; i < 3; i += 1) {
    const reserved = (above ? 1 : 0) + (below ? 1 : 0);
    win = fitWindow(heights, cursor, Math.max(1, c - reserved));
    const nextAbove = win.start > 0;
    const nextBelow = win.end < total;
    if (nextAbove === above && nextBelow === below) {
      break;
    }
    above = above || nextAbove;
    below = below || nextBelow;
  }
  const hiddenAbove = win.start;
  const hiddenBelow = total - win.end;
  return {
    start: win.start,
    end: win.end,
    hiddenAbove,
    hiddenBelow,
    showAbove: above && hiddenAbove > 0,
    showBelow: below && hiddenBelow > 0,
  };
}

/**
 * 表示行オフセット（リストの先頭行を 0 とする）→ 選択肢 index。範囲外なら undefined。
 * 説明の行もその選択肢の一部として扱う（見えている塊のどこを押しても選べる）。
 */
export function choiceIndexAtRow(heights: readonly number[], row: number): number | undefined {
  if (row < 0) {
    return undefined;
  }
  let top = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const rows = heights[i] ?? 0;
    if (row < top + rows) {
      return i;
    }
    top += rows;
  }
  return undefined;
}
