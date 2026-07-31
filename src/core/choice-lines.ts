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
