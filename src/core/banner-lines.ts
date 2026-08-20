import stringWidth from 'string-width';
import type { AccountSummary } from './account';
import { formatUsd } from './cost';
import type { Messages } from './i18n';
import {
  type RateLimitType,
  type RateLimitWindow,
  rateLimitLabelKey,
  resetCountdown,
} from './rate-limit';
import { caretIndexForColumn, indexAtRowCol } from './text-buffer';

/**
 * Semantic emphasis for a header segment. The banner lives in `ui/` but its text
 * is composed here (pure), so tones stay abstract — `ui/theme.ts` is still the only
 * place that knows actual colors (see .claude/rules/ink-components.md).
 */
export type BannerTone = 'normal' | 'dim' | 'accent' | 'warn' | 'error';

/** A styled run of text within one header line. */
export interface BannerSegment {
  readonly text: string;
  readonly tone: BannerTone;
  readonly bold?: boolean;
}

/** One rendered header row. An empty `segments` is a blank spacer row. */
export interface BannerLine {
  readonly segments: readonly BannerSegment[];
}

export interface BannerInput {
  cwd?: string;
  model?: string;
  /** アプリのバージョン（package.json 由来）。ワードマークの右に `vX.Y.Z` で表示。 */
  version?: string;
  sessionCount: number;
  /**
   * 新しいセッションを動かすエージェントの表示名（`/agent` の既定）。固有名詞なので
   * カタログを通さずアダプタの `displayName` をそのまま渡す。取れなければ出さない。
   */
  agent?: string;
  totalCostUsd?: number;
  /** ログイン中のアカウント（プラン名・組織名）。SDK probe 由来で、無ければ出さない。 */
  account?: AccountSummary;
  /**
   * 対象リポジトリが今チェックアウトしているブランチ（新しいセッションの分岐元 =
   * マージ先）。detached HEAD や git の呼び出しに失敗したときは undefined で、
   * その場合は表示しない（プラン名と同じく「取れなければ出さない」扱い）。
   */
  branch?: string;
  /**
   * npm に出ている新しいバージョン（起動時チェックの結果）。undefined なら
   * 「最新」「未確認」「チェック無効」のいずれかで、その区別はここでは出さない
   * （更新が無いときにヘッダを 1 行増やさないため）。
   */
  updateLatest?: string;
}

/** 新しいバージョンがあることを示す記号（翻訳対象ではない）。 */
const UPDATE_MARK = '↑';

/**
 * 同じ行に複数の項目を並べるときの間隔（プラン / モデル / ブランチ、
 * バージョン / セッション数 / 合計コスト）。
 */
const FIELD_GAP = '   ';

/**
 * The header's text block, one entry per rendered row: wordmark /
 * plan + model + branch / cwd / update notice.
 *
 * 使用状況（ゲージ付き）は**この行リストに含めない** — 記号（█ / ░）は `ui/theme.ts` が
 * 持ち、行はドラッグでコピーする対象でもないので、`ui/banner.tsx` が
 * `bannerUsageRows()` を使ってテキスト塊の外に描く（`PrivacySection` と同じ扱い）。
 *
 * Rows are emitted as an explicit list so row index === line index. Mouse
 * hit-testing inverts that mapping to locate the drag-selected characters
 * (`bannerCaretAt`), and a margin inside the block would silently shift every line
 * below it.
 */
export function bannerLines(m: Messages, input: BannerInput): BannerLine[] {
  const lines: BannerLine[] = [];

  // ワードマークは通常色 + Bold、右に dim でバージョン・セッション数・合計コスト。
  const head: BannerSegment[] = [{ text: 'Codiva', tone: 'normal', bold: true }];
  if (input.version) {
    head.push({ text: ` v${input.version}`, tone: 'dim' });
  }
  head.push({ text: `${FIELD_GAP}${m.list.sessionCount(input.sessionCount)}`, tone: 'dim' });
  const cost = input.totalCostUsd ?? 0;
  if (cost > 0) {
    head.push({ text: `${FIELD_GAP}${m.list.totalCost(formatUsd(cost))}`, tone: 'dim' });
  }
  lines.push({ segments: head });

  // プランとモデルは 1 行に並べる（縦に散らすより「どのアカウントの、どのモデルか」を
  // 一目で読める）。プラン名は SDK 由来の表示文字列なのでそのまま出す（i18n の例外）で、
  // 取れない環境（API キー利用など）ではモデルだけの行になる。
  const identity: BannerSegment[] = [];
  if (input.account?.plan) {
    identity.push({
      text: `${m.banner.plan(input.account.plan, input.account.organization)}${FIELD_GAP}`,
      tone: 'dim',
    });
  }
  // 既定のエージェントもこの行に並べる（「何が、どのモデルで動くか」を 1 行で読む）。
  // 一覧の行のエージェント列は混在時だけ出るので、単一 provider で使っている人が
  // 「今どれで動いているか」を確かめられる場所はここになる。
  if (input.agent) {
    identity.push({ text: `${m.banner.agent(input.agent)}${FIELD_GAP}`, tone: 'dim' });
  }
  identity.push({ text: m.banner.model(input.model ?? m.banner.defaultModel), tone: 'dim' });
  // 現在のブランチも**この行**に並べる（cwd 行ではなく）。理由は 2 つ:
  // (1) cwd は長くなりがちで、`wrap="truncate-end"` の行末に置くと狭い端末で真っ先に
  //     切り落とされる。(2) cwd 行はドラッグでパスを取り出す用途なので、行末へ丸める
  //     drag（`bannerCaretAt` の 'clamp'）でブランチ名まで一緒にコピーされてしまう。
  if (input.branch) {
    identity.push({ text: `${FIELD_GAP}${m.banner.branch(input.branch)}`, tone: 'dim' });
  }
  lines.push({ segments: identity });

  if (input.cwd) {
    lines.push({ segments: [{ text: input.cwd, tone: 'dim' }] });
  }
  // 更新があるときだけ 1 行増える。dim ではなくアクセント色にするのは、起動直後に
  // 一度気付いてほしい情報だから（ただし枠は付けず 1 行に留める）。記号は翻訳対象では
  // ないのでここに置く（`usageDetail` の ' · ' と同じ扱い）。
  if (input.updateLatest) {
    lines.push({
      segments: [
        { text: `${UPDATE_MARK} ${m.update.available(input.updateLatest)}`, tone: 'accent' },
        { text: ` · ${m.update.availableHint}`, tone: 'dim' },
      ],
    });
  }

  return lines;
}

/** 使用率の表示幅（`'100%'` に合わせて右詰め）。列を揃えるための固定幅。 */
const PERCENT_CELLS = 4;

/** Semantic tone for a usage window: error when turned away, warn on warning, else accent. */
function usageTone(status: RateLimitWindow['status']): BannerTone {
  if (status === 'rejected') {
    return 'error';
  }
  if (status === 'allowed_warning') {
    return 'warn';
  }
  return 'accent';
}

/**
 * ヘッダの使用状況 1 行ぶんの表示データ。ゲージのセル数は `gaugeCells(percent, width)`、
 * 記号は `ui/theme.ts` が持つので、ここでは**文字列と色調だけ**を決める。
 */
export interface BannerUsageRow {
  /** React キー兼識別子（枠の種類）。 */
  readonly type: RateLimitType;
  /** 枠の見出し。複数行でゲージの開始位置を揃えるため表示幅でパディング済み。 */
  readonly label: string;
  /** 使用率（0-100）。SDK が返さない枠では undefined（ゲージを描かない）。 */
  readonly percent?: number;
  /** 使用率の表示（`' 42%'`）。不明なときは同じ幅の空白（後続の列を揃える）。 */
  readonly percentText: string;
  /** リセットまでの残り時間（無ければ undefined）。 */
  readonly detail?: string;
  /** ゲージと使用率の色調（`ui/theme.ts` が実際の色を決める）。 */
  readonly tone: BannerTone;
}

/**
 * claude.ai の使用リミット枠を、ヘッダに描く行データへ変換する（純粋）。
 *
 * 見出しは**表示幅**でパディングする（`'今週 (Opus)'` のような CJK 混在でもゲージの
 * 左端が揃う）。使用率が無い枠でも `percentText` を同じ幅で返すので、残り時間の列が
 * 行ごとにギザギザにならない。
 */
export function bannerUsageRows(
  m: Messages,
  windows: readonly RateLimitWindow[],
  now: number,
): BannerUsageRow[] {
  const labels = windows.map((w) => m.banner.usage[rateLimitLabelKey(w.type)]);
  const labelCells = Math.max(0, ...labels.map((label) => stringWidth(label)));
  return windows.map((w, i) => {
    const label = labels[i] ?? '';
    const countdown = w.resetsAt === undefined ? undefined : resetCountdown(w.resetsAt, now);
    return {
      type: w.type,
      label: label + ' '.repeat(Math.max(0, labelCells - stringWidth(label))),
      percent: w.utilization,
      percentText:
        w.utilization === undefined
          ? ' '.repeat(PERCENT_CELLS)
          : `${Math.round(w.utilization)}%`.padStart(PERCENT_CELLS),
      detail: countdown
        ? m.banner.usage.resetsIn(countdown.days, countdown.hours, countdown.minutes)
        : undefined,
      tone: usageTone(w.status),
    };
  });
}

/** The plain text of one header line (segments concatenated, styling dropped). */
export function bannerLineText(line: BannerLine): string {
  return line.segments.map((s) => s.text).join('');
}

/**
 * The header as one selectable document: every line joined with '\n'. This is the
 * `value` that selection ranges index into (`core/text-selection.ts`), so the same
 * caret-index arithmetic the composer uses applies unchanged.
 */
export function bannerText(lines: readonly BannerLine[]): string {
  return lines.map(bannerLineText).join('\n');
}

/**
 * Caret index into `bannerText(lines)` for a mouse point inside the header's text
 * block. `contentRow` is the 0-based row within the block (`y` minus its top) and
 * `cells` the display column within that row (`x` minus its left edge). Returns
 * undefined when the point is outside the block — above/below it, or left of it
 * (i.e. on the mascot, which isn't selectable text).
 *
 * `beyondEnd` decides what a point past the row's last character means:
 * - `'reject'` (既定): テキストの上でなければ当たりとしない。press はこちら — 行末より
 *   右の余白でクリックを飲むと、そこに何かを置いたときに黙って奪ってしまう。
 * - `'clamp'`: 行末に丸める。drag はこちら — 行末より先までドラッグしたら「行末まで
 *   選ぶ」のが期待動作（パス全体を選ぶときに数セル行き過ぎるのは普通の操作）。
 *
 * Display-width based via `caretIndexForColumn`, so CJK/emoji in a path or model
 * name map to the right character.
 */
export function bannerCaretAt(
  lines: readonly BannerLine[],
  contentRow: number,
  cells: number,
  beyondEnd: 'reject' | 'clamp' = 'reject',
): number | undefined {
  if (contentRow < 0 || contentRow >= lines.length || cells < 0) {
    return undefined;
  }
  const line = lines[contentRow];
  if (line === undefined) {
    return undefined;
  }
  const text = bannerLineText(line);
  if (beyondEnd === 'reject' && cells > stringWidth(text)) {
    return undefined;
  }
  return indexAtRowCol(bannerText(lines), contentRow, caretIndexForColumn(text, cells));
}
