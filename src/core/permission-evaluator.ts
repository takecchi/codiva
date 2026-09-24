/**
 * リスクベースのツール実行許可（`smart` モード）の DI 境界と、そこへ渡す
 * **provider 非依存**の文脈づくり。純粋（ネットワークも fs も触らない）。
 *
 * なぜ `PermissionPolicy` と別の seam なのか:
 * `PermissionPolicy`（`core/session.ts`）は**同期**の決定関数で、`canUseTool` の
 * ホットパスで毎回呼ばれる。判定に外部 API を使うものを同じ型に押し込むと全 provider の
 * 経路が async 化し、「ネットワークを触らない既定の判定」まで巻き添えになる。
 * そこでポリシーは 3 値（`allow` / `ask` / `evaluate`）へ広げるだけにして、
 * **`evaluate` のときだけ**この非同期の評価器へ降りる。
 *
 * 実 I/O（Jev API）は `utils/jev.ts`、組み立ては `bootstrap/build-manager.ts`。
 * `core/` は HTTP も SDK も知らない（規約: architecture.md）。
 */

import type { AgentId, AgentToolKind, PermissionRequest } from './types';

/**
 * 評価器の答え。**`deny` は「自動拒否」ではない** — 呼び出し側（{@link evaluatePermission}）が
 * `ask` へ昇格させる。判断モデルを最終決定者にせず「確認が必要な操作を人間へ上げる」
 * 用途に限るため（issue #139 の MVP 方針）。
 */
export type PermissionVerdict = 'allow' | 'ask' | 'deny';

/**
 * 評価器へ渡す文脈。**provider 固有の形は一切含めない** — ここに来る時点で
 * アダプタが `PermissionRequest` へ正規化し終えている（規約: sdk-integration.md）。
 *
 * 中身は「判断に要る最小限」に絞ってある（{@link toPermissionContext}）。外部 API へ
 * 出ていく値なので、増やすときは README の送信データの説明も一緒に直す。
 */
export interface PermissionContext {
  /** ツール名（provider の生の名前。例: `Bash` / `run_terminal_command`）。 */
  toolName: string;
  /** 中立のツール種別。アダプタが分からなければ `'other'`。 */
  tool: AgentToolKind;
  /** ツール実行の許可か、ユーザーへの質問か。 */
  kind: PermissionRequest['kind'];
  /** 絞り込み済みのツール入力（{@link redactToolInput}）。 */
  input: Record<string, unknown>;
  /** 直近のユーザー指示（何をさせている最中かの手がかり）。 */
  instruction?: string;
  /** どのエージェントが要求しているか。 */
  agent?: AgentId;
}

/**
 * 許可要求のリスクを判定する外部評価器。**実装は `utils/` 側**（HTTP）で、
 * テストではフェイクを注入する。
 *
 * 契約: **throw してよい**（呼び出し側が安全側 = `ask` へ倒す）。時間の上限も
 * 呼び出し側が持つので、実装側のタイムアウトは best-effort でよい。
 */
export interface PermissionEvaluator {
  evaluate(context: PermissionContext, signal?: AbortSignal): Promise<PermissionVerdict>;
}

/** 1 つの文字列値の上限（これを超えたら `…` を付けて切る）。 */
const MAX_VALUE_CHARS = 400;
/** 送る入力フィールドの上限件数（未知のツールが巨大な入力を持ちうるため）。 */
const MAX_INPUT_FIELDS = 12;
/** 直近指示の上限（判断に要るのは「何をさせているか」だけ）。 */
const MAX_INSTRUCTION_CHARS = 600;

/**
 * 中身を送らずに「大きさ」だけ伝えるフィールド。ファイル本文・差分は
 * **判断に要らないうえ、リポジトリの中身がそのまま外部 API へ出ていく**ので、
 * 長さの目印に置き換える。
 */
const BULK_FIELDS = new Set([
  'content',
  'contents',
  'new_string',
  'old_string',
  'new_str',
  'old_str',
  'file_text',
  'text',
  'body',
  'patch',
  'diff',
]);

/**
 * 値ごと落とすフィールド（鍵・トークンの類）。キー名の部分一致で判定する
 * （`apiKey` / `AUTH_TOKEN` / `x-secret` のどれも拾いたい）。
 */
const SECRET_HINTS = ['token', 'secret', 'password', 'passwd', 'credential', 'apikey', 'api_key'];

function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}

/** 長い文字列を切る（切ったことが分かるように `…` を付ける）。 */
export function clipValue(text: string, max = MAX_VALUE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * ツール入力を「外へ出してよい最小限」へ絞る（純粋）。
 *
 * - 鍵・トークンらしいキーは**丸ごと落とす**
 * - ファイル本文・差分は `<n chars>` の目印に置き換える（中身は送らない）
 * - 文字列は {@link MAX_VALUE_CHARS} で切る
 * - 配列・オブジェクトは要素数だけ（入れ子を辿らない）
 * - 件数は {@link MAX_INPUT_FIELDS} まで
 *
 * ここを緩めると README に書いた「送信されるもの」と実装が食い違うので、
 * 変えるときは README（ja / en 両方）も直す。
 */
export function redactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    if (count >= MAX_INPUT_FIELDS) {
      break;
    }
    if (looksSecret(key)) {
      continue;
    }
    count += 1;
    if (BULK_FIELDS.has(key)) {
      // 中身は送らない。大きさだけ分かれば「巨大な書き換え」の判断材料になる。
      out[key] = typeof value === 'string' ? `<${value.length} chars>` : '<omitted>';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = clipValue(value);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = `<array(${value.length})>`;
      continue;
    }
    if (typeof value === 'object') {
      out[key] = `<object(${Object.keys(value as Record<string, unknown>).length})>`;
      continue;
    }
    // undefined / function / symbol は送らない（JSON にも載らない）。
    count -= 1;
  }
  return out;
}

/**
 * 許可要求 + セッションの文脈 → 評価器へ渡す文脈（純粋）。
 *
 * `tool` が無い要求（種別を報告しない provider・古い経路）は `'other'` に倒す。
 * **推測で埋めない** — ツール名から種別を当てにいくと provider 固有の知識が
 * `core/` の中立モジュールへ漏れる（規約: sdk-integration.md）。
 */
export function toPermissionContext(
  request: Pick<PermissionRequest, 'toolName' | 'input' | 'kind' | 'tool'>,
  extras: { instruction?: string; agent?: AgentId } = {},
): PermissionContext {
  const instruction = extras.instruction?.trim();
  return {
    toolName: request.toolName,
    tool: request.tool ?? 'other',
    kind: request.kind,
    input: redactToolInput(request.input),
    ...(instruction ? { instruction: clipValue(instruction, MAX_INSTRUCTION_CHARS) } : {}),
    ...(extras.agent ? { agent: extras.agent } : {}),
  };
}

export interface EvaluateOptions {
  /** 上限時間。超えたら `ask`（既定 {@link DEFAULT_EVALUATE_TIMEOUT_MS}）。 */
  timeoutMs?: number;
  /** セッションの中断シグナル。abort されたら `ask`。 */
  signal?: AbortSignal;
  /** タイマー注入（テスト用）。 */
  setTimeoutFn?: typeof setTimeout;
}

/** 評価の既定上限（ツール 1 回ごとに待たされる時間なので短く持つ）。 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 1500;

/**
 * 評価器を**安全側に丸めて**呼ぶ（`'allow' | 'ask'` しか返さない）。
 *
 * 守っていること 4 つ:
 * 1. `deny` は自動拒否せず `ask` へ昇格する（判断モデルを最終決定者にしない）。
 * 2. throw・タイムアウト・中断はすべて `ask`（外部 API が落ちていても**勝手に走らない**）。
 * 3. 質問（`kind: 'question'`）は評価器に聞かずに必ず `ask`（それ*が*ユーザーへ聞く経路で、
 *    自動 allow すると空の回答で承諾を返して質問が黙って消える）。
 * 4. 評価器が無ければ `ask`（`smart` を選んだのに黙って全自動にはしない）。
 *
 * 締切（タイムアウト / セッションの中断）が来たら**評価器の答えを待たずに** `ask` で
 * 決着させる。待っているのは provider の `canUseTool` なので、ここで伸びるとターンごと
 * 止まる。評価器の promise は捨てるだけ（キャンセルは `signal` 経由の best-effort）。
 */
export async function evaluatePermission(
  evaluator: PermissionEvaluator | undefined,
  context: PermissionContext,
  opts: EvaluateOptions = {},
): Promise<'allow' | 'ask'> {
  if (!evaluator || context.kind === 'question') {
    return 'ask';
  }
  if (opts.signal?.aborted === true) {
    return 'ask';
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EVALUATE_TIMEOUT_MS;
  const schedule = opts.setTimeoutFn ?? setTimeout;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp = (): void => undefined;
  // 締切（タイムアウト or セッションの中断）。**評価器の答えを待たずに `ask` で決着させる**
  // — 待っているのは provider の `canUseTool` なので、ここで伸びるとターンごと止まる。
  const deadline = new Promise<'ask'>((resolve) => {
    giveUp = () => {
      // 評価器へも伝えて、要らなくなった HTTP を畳めるようにする（best-effort）。
      controller.abort();
      resolve('ask');
    };
  });
  const abort = () => giveUp();
  opts.signal?.addEventListener('abort', abort, { once: true });
  timer = schedule(abort, timeoutMs);
  // 評価中に終了されても、このタイマーがプロセスを生かし続けないように。
  timer?.unref?.();
  try {
    const verdict = await Promise.race([
      evaluator.evaluate(context, controller.signal).catch((): PermissionVerdict => 'ask'),
      deadline,
    ]);
    // `deny` は昇格。未知の値も同じ扱い（安全側）。
    return verdict === 'allow' ? 'allow' : 'ask';
  } catch {
    return 'ask';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    opts.signal?.removeEventListener('abort', abort);
  }
}
