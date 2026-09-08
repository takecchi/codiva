import { clipLogText, pushLogEntry, SUBAGENT_LOG_LIMITS } from './log-buffer';
import type { LogEntry, SubagentOutcome, SubagentRun, SubagentUsage } from './types';

/**
 * 追跡するサブエージェントの本数。8 は並列 explore の実用上限（それ以上走らせても
 * 1 行に畳まれた表示からは追えない）。溢れたぶんは決着済みの古いものから落とす。
 *
 * **これは完了ゲートの上限ではない**（ゲートは `SessionState.activeTaskIds` で無制限）。
 * ここで落としてもゲートは影響を受けない = 早すぎる完了は起きない。
 */
export const MAX_TRACKED_SUBAGENTS = 8;

/**
 * `SubagentRun.prompt` に残す文字数。指示文はまるごと来る（数万文字になりうる）が、
 * 表示用に持つのは頭だけでよい。
 */
export const SUBAGENT_PROMPT_CHARS = 2_000;

/** サブエージェントが走り始めたときに provider から分かるメタ（すべて optional）。 */
export interface SubagentStart {
  id: string;
  toolUseId?: string;
  description?: string;
  kind?: string;
  prompt?: string;
}

/** 進捗で更新されうる項目。 */
export interface SubagentProgress {
  description?: string;
  lastTool?: string;
  usage?: SubagentUsage;
}

/** 決着時に分かる項目。 */
export interface SubagentSettle {
  outcome?: SubagentOutcome;
  summary?: string;
  outputFile?: string;
  usage?: SubagentUsage;
}

function sameUsage(a: SubagentUsage | undefined, b: SubagentUsage | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return (
    a.totalTokens === b.totalTokens && a.toolUses === b.toolUses && a.durationMs === b.durationMs
  );
}

/** 新しい報告を重ねる（欠けている項目は既存の値を保つ）。値が同じなら同一参照。 */
function mergeUsage(
  a: SubagentUsage | undefined,
  b: SubagentUsage | undefined,
): SubagentUsage | undefined {
  if (b === undefined) {
    return a;
  }
  if (a === undefined) {
    return b;
  }
  const next: SubagentUsage = {
    totalTokens: b.totalTokens ?? a.totalTokens,
    toolUses: b.toolUses ?? a.toolUses,
    durationMs: b.durationMs ?? a.durationMs,
  };
  return sameUsage(a, next) ? a : next;
}

/**
 * 表示に使う全項目が等しいか。**再描画を抑えるための参照維持**に使う（`SessionStore` の
 * スナップショットが「変化のないセッションの参照を維持する」のと同じ趣旨）。
 */
function sameRun(a: SubagentRun, b: SubagentRun): boolean {
  return (
    a.toolUseId === b.toolUseId &&
    a.description === b.description &&
    a.kind === b.kind &&
    a.prompt === b.prompt &&
    a.status === b.status &&
    a.lastTool === b.lastTool &&
    a.summary === b.summary &&
    a.outputFile === b.outputFile &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.messages === b.messages &&
    sameUsage(a.usage, b.usage)
  );
}

function replaceAt(
  list: readonly SubagentRun[],
  index: number,
  run: SubagentRun,
): readonly SubagentRun[] {
  const next = [...list];
  next[index] = run;
  return next;
}

/**
 * 上限まで畳む。落とすのは**決着済みのうち最も古いもの**で、全部走っているときだけ
 * 先頭（最古）を落とす。走っているものを優先して残すのは、それが「いま追いたい」対象だから。
 */
function evict(list: readonly SubagentRun[]): readonly SubagentRun[] {
  let next = list;
  while (next.length > MAX_TRACKED_SUBAGENTS) {
    const settled = next.findIndex((run) => run.status !== 'running');
    const drop = settled >= 0 ? settled : 0;
    next = [...next.slice(0, drop), ...next.slice(drop + 1)];
  }
  return next;
}

/**
 * サブエージェントが走り始めた。**同じ id で 2 回来ても増やさない**（冪等）で、
 * 既存の記録には欠けているメタだけを足す。
 */
export function startSubagent(
  list: readonly SubagentRun[] | undefined,
  input: SubagentStart,
  at: number,
): readonly SubagentRun[] {
  const current = list ?? [];
  const index = current.findIndex((run) => run.id === input.id);
  const existing = index >= 0 ? current[index] : undefined;
  if (existing !== undefined) {
    // 既存の値を優先する（進捗で更新された description を start の再送で巻き戻さない）。
    const merged: SubagentRun = {
      ...existing,
      toolUseId: existing.toolUseId ?? input.toolUseId,
      description: existing.description ?? input.description,
      kind: existing.kind ?? input.kind,
      prompt: existing.prompt ?? clipPrompt(input.prompt),
    };
    return sameRun(existing, merged) ? current : replaceAt(current, index, merged);
  }
  const run: SubagentRun = {
    id: input.id,
    toolUseId: input.toolUseId,
    description: input.description,
    kind: input.kind,
    prompt: clipPrompt(input.prompt),
    status: 'running',
    startedAt: at,
    messages: [],
  };
  return evict([...current, run]);
}

function clipPrompt(prompt: string | undefined): string | undefined {
  return prompt === undefined ? undefined : clipLogText(prompt, SUBAGENT_PROMPT_CHARS);
}

/**
 * 進捗の報告。**記録が無ければ何もしない**（ここで作らない） — 進捗はエッジでも
 * レベル信号でもないので、これを起点に追跡を始めると「進捗だけ来て決着が来ない」
 * 記録が残り続ける。決着済みの記録も触らない（遅れて届いた進捗で実行中に戻さない）。
 */
export function progressSubagent(
  list: readonly SubagentRun[] | undefined,
  taskId: string,
  patch: SubagentProgress,
): readonly SubagentRun[] | undefined {
  if (list === undefined) {
    return undefined;
  }
  const index = list.findIndex((run) => run.id === taskId);
  const existing = index >= 0 ? list[index] : undefined;
  if (existing === undefined || existing.status !== 'running') {
    return list;
  }
  const next: SubagentRun = {
    ...existing,
    description: patch.description ?? existing.description,
    lastTool: patch.lastTool ?? existing.lastTool,
    usage: mergeUsage(existing.usage, patch.usage),
  };
  return sameRun(existing, next) ? list : replaceAt(list, index, next);
}

/**
 * 決着の報告。**最初の決着が勝つ**（`task_updated` と `task_notification` の 2 経路から
 * 届くので、後続は欠けているフィールドだけを埋め、`finishedAt` は上書きしない）。
 *
 * `taskId` が無い決着（provider が誰の決着か言わない）では**表示を触らない** —
 * ゲート側は「全部畳む」で安全側に倒すが、表示で全部を決着済みにすると走っている
 * サブエージェントが終わったように見える嘘になる。
 */
export function settleSubagent(
  list: readonly SubagentRun[] | undefined,
  taskId: string | undefined,
  patch: SubagentSettle,
  at: number,
): readonly SubagentRun[] | undefined {
  if (list === undefined || taskId === undefined) {
    return list;
  }
  const index = list.findIndex((run) => run.id === taskId);
  const existing = index >= 0 ? list[index] : undefined;
  if (existing === undefined) {
    return list;
  }
  const settled = existing.status !== 'running';
  const next: SubagentRun = {
    ...existing,
    status: settled ? existing.status : (patch.outcome ?? 'stopped'),
    summary: existing.summary ?? patch.summary,
    outputFile: existing.outputFile ?? patch.outputFile,
    usage: mergeUsage(existing.usage, patch.usage),
    finishedAt: existing.finishedAt ?? at,
  };
  return sameRun(existing, next) ? list : replaceAt(list, index, next);
}

/**
 * 走っている印を封じる（`running` → `stopped`）。記録そのものは残す。
 *
 * ターン終端（`clearTurnState`）と CLI プロセスの起き直し（`session_started`）で通す。
 * そのあと決着の報告は二度と来ないので、封じないと**スピナーが永久に回る**。
 */
export function sealSubagents(
  list: readonly SubagentRun[] | undefined,
  at: number,
): readonly SubagentRun[] | undefined {
  if (list === undefined) {
    return undefined;
  }
  let changed = false;
  const next = list.map((run) => {
    if (run.status !== 'running') {
      return run;
    }
    changed = true;
    return { ...run, status: 'stopped' as const, finishedAt: run.finishedAt ?? at };
  });
  return changed ? next : list;
}

/** 帰属キー（親側のツール実行 id）で引く。 */
export function findSubagentByRef(
  list: readonly SubagentRun[] | undefined,
  ref: string,
): SubagentRun | undefined {
  return list?.find((run) => run.toolUseId === ref);
}

/**
 * ログ 1 行をサブエージェント専用ログへ積む（予算は {@link SUBAGENT_LOG_LIMITS}）。
 *
 * **帰属先が引けなければ `undefined` を返す**。呼び側の契約は「undefined なら親ログへ
 * 落とす」で、これにより未知の provider・未知の id でも**行を捨てない**（現状挙動へ degrade）。
 */
export function appendSubagentLog(
  list: readonly SubagentRun[] | undefined,
  ref: string,
  entry: LogEntry,
): readonly SubagentRun[] | undefined {
  if (list === undefined) {
    return undefined;
  }
  const index = list.findIndex((run) => run.toolUseId === ref);
  const existing = index >= 0 ? list[index] : undefined;
  if (existing === undefined) {
    return undefined;
  }
  return replaceAt(list, index, {
    ...existing,
    messages: pushLogEntry(existing.messages, entry, SUBAGENT_LOG_LIMITS),
  });
}

/**
 * 走っているものだけ。**完了ゲートではない**（ゲートは `activeTaskIds`）ので、
 * これを見て「ターンが終わったか」を判断してはいけない — 表示のためだけに使う。
 */
export function activeSubagents(list: readonly SubagentRun[] | undefined): readonly SubagentRun[] {
  return list?.filter((run) => run.status === 'running') ?? [];
}
