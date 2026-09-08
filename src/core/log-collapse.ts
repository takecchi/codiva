import type { Messages } from './i18n';
import type { AgentToolKind, LogEntry } from './types';

/**
 * 会話ログの中の「連続したツール実行」を 1 行のまとめへ畳むための純粋ロジック。
 *
 * なぜ要るか: エージェントの作業の大半は `⏺ Bash(…)` / `⎿ …` の 2 行組が延々と続く
 * ものになる。読みたいのは**本文（アシスタントの説明）とユーザーの指示**なのに、
 * ツールの実況がその何倍も場所を取り、少し目を離すと会話が画面の外へ流れていく。
 * まとまりを `1 ファイルを読み込み・5 個のコマンドを実行` の 1 行に畳むと、
 * 会話の筋がそのまま読めるようになる（Claude Code の transcript と同じ発想）。
 *
 * ここは**行を数えて分類するだけ**で、描画も状態も持たない:
 * - どこが 1 まとまりか → {@link collapsibleRunAt}
 * - まとめ行の文言 → {@link toolRunLabel}（文字列はカタログから引く）
 * - 実際に行へ落とすのは `core/scroll.ts` の `logLines`、展開状態を持つのは詳細ビュー。
 */

/** まとめ行に出す、ツール種別ごとの件数（0 件の種別は持たない）。 */
export type ToolRunCounts = Partial<Record<AgentToolKind, number>>;

/**
 * 畳むのに必要な**ツール呼び出しの最低件数**。
 *
 * 1 件だけの実行を畳まないのは、`Read src/core/scroll.ts` のような行がそれ自体で
 * 十分読めるうえ、畳むと**ファイル名やコマンドが消えて情報が減る**（`1 ファイルを
 * 読み込み` としか出せない）ため。行数も 2 行 → 1 行にしかならず、得も小さい。
 * 2 件以上まとまって初めて「何をしていたか」を要約する意味が出る。
 */
export const MIN_COLLAPSE_TOOLS = 2;

/** 畳める 1 まとまり（`messages` の連続した範囲）。 */
export interface ToolRun {
  /**
   * まとめ行の識別子 = 先頭エントリの `seq`。
   *
   * `seq` は**振り直されない**（ログが上限に達して古い行が落ちても、残った行の番号は
   * そのまま）ので、展開/折り畳みの状態をこの値で覚えておける。行 index を使うと
   * 追記のたびに意味が変わってしまう。
   */
  readonly key: number;
  /** `messages` 内の開始 index。 */
  readonly start: number;
  /** `messages` 内の終了 index（排他）。 */
  readonly end: number;
  /** ツール呼び出し（`tool_use`）の件数。 */
  readonly tools: number;
  /** 種別ごとの内訳（まとめ行の文言のもと）。 */
  readonly counts: ToolRunCounts;
}

/** ツール実行の 2 行組（呼び出しとその結果）か。 */
export function isToolLogEntry(entry: LogEntry): boolean {
  return entry.kind === 'tool_use' || entry.kind === 'tool_result';
}

/**
 * `start` から始まる「畳めるツール実行のまとまり」を返す（畳めないなら undefined）。
 *
 * 成立条件は 3 つ:
 *
 * 1. **`tool_use` で始まる**。宙に浮いた `tool_result`（結果だけが残った行）から
 *    まとめを始めない。
 * 2. **末尾に届いていない**（`end < messages.length`）。ログの一番後ろのまとまりは
 *    「いま動いている作業」なので畳まない — 何をしているか見えなくなるのは、
 *    整理された表示より確実に不便。次の本文・指示が届いた時点で自動的に畳まれる。
 * 3. **ツール呼び出しが {@link MIN_COLLAPSE_TOOLS} 件以上**。
 *
 * エージェントの切替（`LogEntry.agent` の変化）でも切る。まとまりが切替をまたぐと、
 * `logLines` が挿む区切り行の位置とまとめ行の帰属が食い違うため。
 */
export function collapsibleRunAt(
  messages: readonly LogEntry[],
  start: number,
): ToolRun | undefined {
  const first = messages[start];
  if (first?.kind !== 'tool_use') {
    return undefined;
  }
  const counts: ToolRunCounts = {};
  let tools = 0;
  let end = start;
  while (end < messages.length) {
    const entry = messages[end];
    if (!entry || !isToolLogEntry(entry) || entry.agent !== first.agent) {
      break;
    }
    if (entry.kind === 'tool_use') {
      const kind = entry.tool ?? 'other';
      counts[kind] = (counts[kind] ?? 0) + 1;
      tools += 1;
    }
    end += 1;
  }
  if (end >= messages.length || tools < MIN_COLLAPSE_TOOLS) {
    return undefined;
  }
  return { key: first.seq, start, end, tools, counts };
}

/**
 * まとめ行に出す種別の順。「読む → 書く → 走らせる → 探す」という作業の流れ順で、
 * 目的のはっきりしないもの（todo / 質問 / その他）を後ろに置く。
 */
const KIND_ORDER: readonly AgentToolKind[] = [
  'read',
  'edit',
  'shell',
  'search',
  'todo',
  'question',
  'other',
];

/**
 * まとめ行の文言（`1 ファイルを読み込み・5 個のコマンドを実行`）。
 *
 * 語そのものはカタログが持ち（言語ごとに語順も複数形も違う）、ここは**どの種別を
 * どの順で並べて何で繋ぐか**だけを決める。カタログを引くだけの UI 側に置くと
 * テストできないので、純関数として core に置いて `Messages` を引数で受ける
 * （`badgeFor` などと同じ形）。
 */
export function toolRunLabel(counts: ToolRunCounts, m: Messages): string {
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const n = counts[kind] ?? 0;
    if (n > 0) {
      parts.push(m.detail.toolRun[kind](n));
    }
  }
  return parts.join(m.detail.toolRunSeparator);
}
