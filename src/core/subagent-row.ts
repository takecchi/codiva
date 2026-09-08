import stringWidth from 'string-width';
import type { ChoiceRowItem } from './choice-lines';
import { formatDuration } from './format';
import type { Messages } from './i18n';
import { wrapDisplayLines } from './scroll';
import type { SubagentRun, SubagentStatus } from './types';

/**
 * 詳細ビューのログ下段に出す 1 行の中身。
 *
 * **行そのものは常に 1 行**で、認証・再開・`Ctrl+C` の案内と**同居**している
 * （`ui/session-detail.tsx` の操作ヒント行）。独立した行にすると
 * `DETAIL_CHROME_ROWS` が 1 増え、そこから引き算する `dialogMaxRows` のせいで
 * 24 行の端末では質問ダイアログの選択肢が窓に 1 件も入らなくなる。
 * 高さを状態で変えないのは `core/scroll.ts` の `LogStatusRow` と同じ理由。
 */
export type SubagentRowState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'one'; readonly run: SubagentRun }
  | { readonly kind: 'many'; readonly run: SubagentRun; readonly others: number };

/**
 * 1 行に出す代表を選ぶ。走っているものを優先し、その中で**配列の最後**（＝最後に
 * 起動されたもの）を採る。
 *
 * 時刻の比較にしないのは**揺れないことを優先**するため — 同じ `startedAt` を持つ
 * 並列起動で代表が入れ替わると、行の文言が理由なくちらつき、クリックの行き先も変わる。
 * `SessionState.subagents` は append 順で安定していることが契約なので、index が
 * そのまま安定な順序になる。
 */
export function subagentRow(runs: readonly SubagentRun[] | undefined): SubagentRowState {
  const list = runs ?? [];
  const running = list.filter((run) => run.status === 'running');
  const run = (running.length > 0 ? running : list).at(-1);
  if (run === undefined) {
    return { kind: 'idle' };
  }
  return list.length === 1 ? { kind: 'one', run } : { kind: 'many', run, others: list.length - 1 };
}

/** 行の中の項目の区切り（記号なので翻訳対象ではない）。 */
const SEPARATOR = ' · ';

function statusLabel(status: SubagentStatus, m: Messages): string {
  switch (status) {
    case 'running':
      return m.subagent.statusRunning;
    case 'completed':
      return m.subagent.statusDone;
    case 'failed':
      return m.subagent.statusFailed;
    default:
      return m.subagent.statusStopped;
  }
}

/** 行に出す「名前」。種別（`subagent_type`）が無ければ説明、それも無ければ id。 */
function nameOf(run: SubagentRun): string {
  return run.kind ?? run.description ?? run.id;
}

/**
 * 経過時間。provider が報告した所要時間を最優先で使い（**毎秒の再描画が要らなくなる**）、
 * 無ければ終了時刻、それも無ければ `now` との差。`now` を渡さなければ出さない。
 */
export function subagentElapsedMs(run: SubagentRun, now?: number): number | undefined {
  if (run.usage?.durationMs !== undefined) {
    return run.usage.durationMs;
  }
  if (run.finishedAt !== undefined) {
    return Math.max(0, run.finishedAt - run.startedAt);
  }
  return now === undefined ? undefined : Math.max(0, now - run.startedAt);
}

export interface SubagentRowLabel {
  /** 表示幅に**切ったあと**の 1 行。 */
  text: string;
  /** その表示幅（= クリック当たり判定の右端）。 */
  width: number;
}

/**
 * 1 行ぶんのラベルを組み、**表示幅に切って**返す。
 *
 * 切るのがここの仕事の半分。経過時間と説明は頻繁に変わるので、切らずに `<Text>` へ
 * 渡すと Ink のプロセスグローバルな上限なしキャッシュに毎フレーム新しいキーが積まれる
 * （`wrap="truncate-end"` は描画時に切るだけで、キャッシュのキーは切る前の文字列）。
 *
 * 返す `width` は**行末より右をクリックの当たりにしない**ために使う。ログや一覧と違って
 * この行の右側は何も無い余白なので、そこで画面遷移が起きるのは意図しない副作用になる。
 */
export function subagentRowLabel(
  row: SubagentRowState,
  m: Messages,
  prefix: string,
  width: number,
  now?: number,
): SubagentRowLabel | undefined {
  if (row.kind === 'idle') {
    return undefined;
  }
  const { run } = row;
  const name = nameOf(run);
  const parts = [
    row.kind === 'many' ? m.subagent.rowMany(name, row.others) : m.subagent.row(name),
    statusLabel(run.status, m),
  ];
  // 説明は名前として既に出ているなら重ねない。
  if (run.description !== undefined && run.description !== name) {
    parts.push(run.description);
  }
  if (run.lastTool !== undefined) {
    parts.push(run.lastTool);
  }
  const elapsed = subagentElapsedMs(run, now);
  if (elapsed !== undefined) {
    parts.push(formatDuration(elapsed));
  }
  // 折返しではなく**先頭 1 行だけ**を採る（この行の高さは常に 1）。
  const text = wrapDisplayLines(prefix + parts.join(SEPARATOR), width)[0] ?? '';
  return { text, width: stringWidth(text) };
}

/**
 * 実測した 1 行の矩形と**ラベルの表示幅の内側**に当たったか。
 *
 * 実測できていない・縦に潰れている（`height < 1`）間は当たり判定そのものをやめる
 * （黙って別の場所を押したことにするより、押せないほうがよい）。
 */
export function subagentRowHit(
  point: { readonly x: number; readonly y: number },
  box: { readonly top: number; readonly left: number },
  height: number,
  labelWidth: number,
): boolean {
  if (height < 1 || labelWidth <= 0) {
    return false;
  }
  // 1 行しか無いので厳密一致（複数行に潰れ広がった場合は当たりにしない）。
  if (point.y !== box.top) {
    return false;
  }
  const column = point.x - box.left;
  return column >= 0 && column < labelWidth;
}

/**
 * 複数件あるときの選択ダイアログの選択肢。**描画と当たり判定に同じ配列を渡す**こと
 * （`choiceRowHeights` / `choiceIndexAtRow` は 1 件 = 1 行を前提にしていない）。
 */
export function subagentChoices(
  runs: readonly SubagentRun[],
  m: Messages,
  now?: number,
): ChoiceRowItem[] {
  return runs.map((run) => {
    const elapsed = subagentElapsedMs(run, now);
    const detail = [
      statusLabel(run.status, m),
      run.lastTool,
      elapsed === undefined ? undefined : formatDuration(elapsed),
    ].filter((part): part is string => part !== undefined);
    return {
      choice: {
        label: nameOf(run),
        description: [run.description, detail.join(SEPARATOR)]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .join(SEPARATOR),
      },
      prefix: '',
    };
  });
}
