import type { PrRef } from './types';

/**
 * 1 セッションが出す PR は 1 本とは限らない。codiva 自身が作る「セッションブランチの PR」
 * （`pr` / `prStatus`。`gh` に問い合わせて追跡する）とは別に、セッション自身が
 * `gh pr create` で別ブランチの PR を切ることがある（作業を分割した / 先に前提を通した）。
 * それを拾うのがこのモジュール。
 *
 * **ブランチ名からは辿れない**（codiva は `codiva/<slug>` しか知らない）ので、
 * 出所はセッションのツール実行そのものにする: `gh pr create` を実行した tool_use の
 * **結果**に出る PR の URL を読む。ログ全体から URL を拾わないのは誤検出を避けるため —
 * `gh pr list` の出力や、他人の PR を `gh pr view` / WebFetch で覗いただけのものまで
 * 「このセッションが出した PR」に化ける（一覧の `+n` が意味を失う）。
 *
 * すべて純粋関数。SDK メッセージの形を知っているのは `core/claude-parse.ts` だけなので、
 * ここは「文字列 → PrRef[]」の変換に徹する。
 */

/**
 * PR の URL。`https://<host>/<owner>/<repo>/pull/<number>` を拾う。GitHub Enterprise の
 * 独自ホストも同じ形なのでホストは固定しない（結果の出所が `gh pr create` に限られている
 * ぶん、ホストで絞る必要がない）。番号の後ろ（`/files` 等）は正規化で捨てる。
 */
const PR_URL_SOURCE = String.raw`https?:\/\/[\w.-]+(?::\d+)?\/[\w.-]+\/[\w.-]+\/pull\/(\d+)`;

/** `gh pr create ...`（`&&` やパイプで繋がれていてもよい）。 */
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;

/**
 * 同じコマンド行に混ざっていると、出力が「作った PR」だけとは限らなくなるもの。
 * `gh pr create --fill || gh pr list --head "$B" --json url`（作成に失敗したら既存を探す）は
 * エージェントがよく書く形で、これを作成コマンドとして扱うと**一覧に出た PR を全部**
 * このセッションの PR として数えてしまう。取りこぼす（`+n` が出ない）ほうが、無関係な
 * PR を並べるより害が小さいので、混在しているときは検知しない。
 */
const GH_PR_READ_RE = /\bgh\s+(?:pr\s+(?:list|view|status|checks|diff)|search)\b/;

/** MCP の GitHub サーバ等、ツール名だけで「PR を作る」と分かるもの。 */
const CREATE_PR_TOOL_RE = /create_pull_request/i;

/**
 * 1 セッションが保持する PR 参照の上限。暴走したセッションがログ由来の参照を無限に
 * 積むのを防ぐ保険（`state.json` にも載るので上限は必須）。超えたぶんは捨てる。
 */
export const MAX_SESSION_PRS = 12;

/**
 * tool_result のうち PR URL を探す先頭文字数。`gh pr create` は URL を最終行に出すが、
 * その前に "Creating pull request for ..." や警告が数行入る。全文（メガバイト級もある）を
 * 走査しないための上限。
 */
export const PR_DETECT_SCAN_CHARS = 4000;

/** Bash コマンドが PR を作る**だけ**のものか（`gh pr create`。読み取り系との混在は除く）。 */
export function isPrCreateCommand(command: string): boolean {
  return GH_PR_CREATE_RE.test(command) && !GH_PR_READ_RE.test(command);
}

/**
 * この tool_use は PR を作るものか。`Bash` はコマンド本文で、それ以外はツール名で判定する
 * （MCP の `create_pull_request` 系）。判定が真のときだけ結果を走査するので、
 * ここが誤検出の唯一の入口になる。
 */
export function isPrCreateTool(name: string, input: Record<string, unknown>): boolean {
  if (CREATE_PR_TOOL_RE.test(name)) {
    return true;
  }
  if (name !== 'Bash') {
    return false;
  }
  const command = input.command;
  return typeof command === 'string' && isPrCreateCommand(command);
}

/**
 * テキスト中の PR URL をすべて `PrRef` にする（出現順・URL で重複排除）。
 * URL は `.../pull/<n>` に正規化するので、`/files` 付きで出てきても同じ PR に畳まれる。
 */
export function extractPrRefs(text: string): PrRef[] {
  const out: PrRef[] = [];
  const seen = new Set<string>();
  // 正規表現は**呼び出しごとに作る**。`/g` を共有インスタンスにすると `lastIndex` が
  // 呼び出しを跨いで残り、途中で return を足した瞬間に次回の走査が途中から始まる。
  for (const match of text.matchAll(new RegExp(PR_URL_SOURCE, 'g'))) {
    const number = Number(match[1]);
    // `/pull/<n>` までを URL とする（後ろのサブパス・クエリは落とす）。
    const url = match[0];
    if (Number.isSafeInteger(number) && number > 0 && !seen.has(url)) {
      seen.add(url);
      out.push({ number, url });
    }
  }
  return out;
}

/**
 * 既知の参照に新しく見つけたものを足す。**何も増えなければ同じ配列参照を返す** —
 * `extraPrs` は永続対象で、保存の要否は参照比較（`persistRelevantChanged`）で決まるため、
 * 毎ツール結果ごとに新しい配列を作ると state.json が無駄に書き直される。
 */
export function addPrRefs(
  existing: readonly PrRef[] | undefined,
  found: readonly PrRef[],
): readonly PrRef[] | undefined {
  if (found.length === 0) {
    return existing;
  }
  const current = existing ?? [];
  // 上限に達したら**同じ参照を返して打ち止める**。切り詰めた新配列を返すと、内容が
  // 同じでも参照が変わるので state.json の再保存と再描画が検知のたびに走る。
  if (current.length >= MAX_SESSION_PRS) {
    return existing;
  }
  const fresh = found.filter((ref) => !current.some((e) => e.url === ref.url));
  if (fresh.length === 0) {
    return existing;
  }
  return [...current, ...fresh].slice(0, MAX_SESSION_PRS);
}

/**
 * 参照リストから 1 件を取り除く。**取り除くものが無ければ同じ配列参照を返す**
 * （{@link addPrRefs} と同じ理由 = 無駄な再保存・再描画を起こさない）。
 */
export function withoutPrRef(
  existing: readonly PrRef[] | undefined,
  ref: PrRef | undefined,
): readonly PrRef[] | undefined {
  if (!ref || !existing || existing.length === 0) {
    return existing;
  }
  const rest = existing.filter((p) => p.url !== ref.url);
  if (rest.length === existing.length) {
    return existing;
  }
  return rest.length > 0 ? rest : undefined;
}

/** PR 参照を持つセッション状態の最小形（表示ヘルパはこれだけを要求する）。 */
export interface PrRefsHolder {
  /** セッションブランチの PR（codiva が追跡・操作する本命）。 */
  pr?: PrRef;
  /** セッション自身が別ブランチに作った PR。 */
  extraPrs?: readonly PrRef[];
}

/**
 * 一覧・詳細で「代表」として出す PR。セッションブランチの PR を優先する — codiva が
 * ステータス（グリフ）を持っているのはこれだけで、クリックで開く先とグリフの意味を
 * 一致させる必要があるため。ブランチの PR が無ければ**最後に見つかった**ものを出す。
 */
export function primaryPr(state: PrRefsHolder): PrRef | undefined {
  return state.pr ?? state.extraPrs?.at(-1);
}

/** PR を持たないセッション用の共有空配列（行ごと・描画ごとの無駄な確保を避ける）。 */
const NO_PRS: readonly PrRef[] = [];

/** 代表を除いた残り（詳細ビューの一覧用。発見順）。 */
export function otherPrs(state: PrRefsHolder): readonly PrRef[] {
  const extras = state.extraPrs;
  if (!extras || extras.length === 0) {
    return NO_PRS;
  }
  const primary = primaryPr(state);
  return primary ? extras.filter((p) => p.url !== primary.url) : extras;
}

/** 複数の PR を出したセッションか（一覧の `+n` と列幅の切替に使う）。 */
export function hasMultiplePrs(state: PrRefsHolder): boolean {
  return otherPrs(state).length > 0;
}

/** 表示順（代表 → 残り）に並べた全 PR。詳細ビューの一覧はこの順で描く。 */
export function allPrs(state: PrRefsHolder): readonly PrRef[] {
  const primary = primaryPr(state);
  return primary ? [primary, ...otherPrs(state)] : [];
}
