import type { PermissionContext, PermissionEvaluator, PermissionVerdict } from '@/core';

/**
 * Jev（TypeSafe AI の「判断専用」モデル）で許可要求のリスクを判定する I/O。
 * 判定の使い方（`deny` の昇格・タイムアウト時の安全側）は純粋な
 * `core/permission-evaluator.ts` が持ち、ここは **HTTP 1 往復だけ**を担当する。
 *
 * **SDK パッケージ（`@typesafe-ai/sdk`）は入れない。** これは `smart` モードを
 * 使う人にしか要らない機能なので、使わないユーザーにまで依存を配りたくない
 * （`claude` / `codex` / `gh` を同梱しないのと同じ方針。規約: sdk-integration.md）。
 * 必要なのは `POST /v1/systemone` の 1 本だけで、素の `fetch` で足りる。
 *
 * API の形（実測ではなく公式ドキュメント `docs.typesafe.ai/api.md` 準拠）:
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>
 *   { "state": <string|object>, "model": "jev-latest", "questions": { <key>: <typed question> } }
 *   → { "model": "...", "answers": { <key>: { type:'choice', choice, confidence, probabilities } } }
 */

/** 既定のエンドポイント（`TYPESAFE_BASE_URL` / 設定 `jev.baseUrl` で差し替え可）。 */
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const SYSTEM_ONE_PATH = '/v1/systemone';
/** 既定のモデル（別名。TypeSafe 側で最新版に解決される）。 */
const DEFAULT_MODEL = 'jev-latest';
/** 質問のキー。応答の `answers` から引くのに使う。 */
const QUESTION_KEY = 'gate';
/** API キーを読む環境変数（TypeSafe 公式 SDK と同じ名前）。**設定ファイルには置かない。** */
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY';
/** ベース URL の環境変数（公式 SDK と同じ）。 */
const JEV_BASE_URL_ENV = 'TYPESAFE_BASE_URL';

/**
 * 判定させる選択肢。**`criteria` の説明文は AI 向けのプロンプトなので i18n カタログに
 * 置かず英語で固定する**（規約: sdk-integration.md「AI 向けのプロンプト文字列は
 * i18n カタログに置かない」）。
 *
 * `deny` を選択肢に残してあるのは、モデルに「危険」と「要確認」を分けて答えさせる
 * ため。codiva 側は `deny` も `ask` へ昇格する（`evaluatePermission`）ので、
 * ここでの区別は判定の質のためだけに使う。
 */
const CRITERIA: Record<PermissionVerdict, string> = {
  allow:
    'Routine and low risk: the effect stays inside the session workspace and is easy to undo ' +
    '(reading files, searching, running tests, linters, builds, type checks, local git commands ' +
    'such as status/diff/add/commit/branch, installing declared dependencies, editing source files).',
  ask:
    'Worth a human look before it runs: it reaches outside the workspace, is hard to undo, ' +
    'or has effects beyond this repository (pushing, opening or merging pull requests, deploying, ' +
    'publishing packages, network calls to unfamiliar hosts, editing global config or dotfiles ' +
    'outside the workspace, touching credentials).',
  deny:
    'Clearly destructive or dangerous: irreversible data loss or history rewriting ' +
    '(recursive deletes outside the workspace, force pushes, resetting/discarding uncommitted work, ' +
    'dropping databases, exfiltrating secrets, disabling security controls, piping a downloaded ' +
    'script straight into a shell).',
};

const INSTRUCTIONS =
  'A coding agent is working autonomously inside an isolated, throwaway git worktree of a ' +
  'software repository. It wants to run the tool call described by this state. ' +
  'Decide whether the tool call should run automatically or be shown to the human first. ' +
  'Judge the tool call itself, not whether the instruction is a good idea.';

/** `fetch` の必要な部分だけ（テストでフェイクを注入するため）。 */
export type JevFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface JevEvaluatorOptions {
  /** API キー。省略時は環境変数 `TYPESAFE_API_KEY`。無ければ評価器を作らない。 */
  apiKey?: string;
  /** ベース URL。省略時は `TYPESAFE_BASE_URL` → {@link DEFAULT_BASE_URL}。 */
  baseUrl?: string;
  /** モデル id（既定 `jev-latest`）。 */
  model?: string;
  /**
   * `allow` を採用する確率のしきい値（0〜1、既定 0.9）。モデルが `allow` を選んでも
   * その確率がこれ未満なら `ask` に倒す（TypeSafe のドキュメントも「> 0.9 なら自動で
   * 動かしてよい」を目安にしている）。
   */
  allowThreshold?: number;
  /** HTTP の上限（既定 10 秒。実際の締切は呼び出し側の `evaluatePermission`）。 */
  timeoutMs?: number;
  fetchFn?: JevFetch;
  env?: NodeJS.ProcessEnv;
  /** codiva のバージョン（User-Agent に載せる）。 */
  version?: string;
  /** 時刻（バックオフの計測。テストで差し替える）。 */
  now?: () => number;
}

/** しきい値の既定。 */
const DEFAULT_ALLOW_THRESHOLD = 0.9;
/** HTTP 単体の上限（公式 SDK の既定と同じ）。 */
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * 連続でこの回数失敗したら、しばらく問い合わせ自体をやめる。
 *
 * オフライン・キー切れ・レート制限は**次の 1 回でも直らない**のに、毎ツールごとに
 * 締切（既定 1.5 秒）ぶん待たされる。200 回ツールを叩くセッションで 5 分の死に時間に
 * なるので、`utils/pr.ts` の `PR_LOOKUP_BACKOFF_MS` と同じ考え方で止める。
 * 止まっている間の判定は `ask` = 実質 `確認モード` なので、安全側は保たれる。
 */
const FAILURE_THRESHOLD = 3;
/** 問い合わせを止めておく時間。 */
const BACKOFF_MS = 60_000;

interface ChoiceAnswer {
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probabilityOf(answer: ChoiceAnswer, label: string): number | undefined {
  const probs = answer.probabilities;
  if (isObject(probs) && typeof probs[label] === 'number') {
    return probs[label];
  }
  return typeof answer.confidence === 'number' ? answer.confidence : undefined;
}

/**
 * 応答 JSON → 判定（純粋）。**読めない応答は `ask`** に倒す（形が変わっても
 * 「勝手に走る」側へは絶対に落とさない）。
 */
export function toJevVerdict(json: unknown, allowThreshold: number): PermissionVerdict {
  if (!isObject(json) || !isObject(json.answers)) {
    return 'ask';
  }
  const answer = json.answers[QUESTION_KEY];
  if (!isObject(answer) || typeof answer.choice !== 'string') {
    return 'ask';
  }
  const choice = answer.choice;
  if (choice === 'deny') {
    return 'deny';
  }
  if (choice !== 'allow') {
    return 'ask';
  }
  // `allow` は確率がしきい値以上のときだけ採用する。分布が読めなければ採用しない。
  const probability = probabilityOf(answer as ChoiceAnswer, 'allow');
  return probability !== undefined && probability >= allowThreshold ? 'allow' : 'ask';
}

/**
 * 評価器へ渡す `state`。**`PermissionContext` は既に絞り込み済み**
 * （`core/permission-evaluator.ts` の `redactToolInput`）なので、ここでは
 * そのまま JSON として載せるだけで、追加で何かを足さない。
 */
function toState(context: PermissionContext): Record<string, unknown> {
  return {
    tool_name: context.toolName,
    tool_kind: context.tool,
    tool_input: context.input,
    ...(context.instruction ? { user_instruction: context.instruction } : {}),
    ...(context.agent ? { coding_agent: context.agent } : {}),
  };
}

/**
 * Jev を使う {@link PermissionEvaluator} を作る。**API キーが無ければ `undefined`**
 * （= `smart` モードは選べないまま、既存の挙動が 1 ミリも変わらない）。
 *
 * この関数はネットワークを触らない（キーの有無を見るだけ）。実際の通信は
 * 許可要求が来たときの 1 往復だけで、**セッションが `smart` モードで走っている間しか
 * 発生しない**。
 */
export function createJevEvaluator(
  opts: JevEvaluatorOptions = {},
): PermissionEvaluator | undefined {
  const env = opts.env ?? process.env;
  const apiKey = (opts.apiKey ?? env[JEV_API_KEY_ENV] ?? '').trim();
  if (apiKey.length === 0) {
    return undefined;
  }
  const baseUrl = (opts.baseUrl ?? env[JEV_BASE_URL_ENV] ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const allowThreshold = opts.allowThreshold ?? DEFAULT_ALLOW_THRESHOLD;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn: JevFetch =
    opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init) as ReturnType<JevFetch>);
  const userAgent = `codiva/${opts.version ?? '0.0.0'}`;
  const now = opts.now ?? Date.now;
  // 連続失敗のバックオフ（この評価器インスタンスに閉じた状態）。
  let failures = 0;
  let pausedUntil = 0;

  /** 失敗を数え、続くようなら問い合わせを止める。返り値は常に安全側の `ask`。 */
  const giveUp = (): PermissionVerdict => {
    failures += 1;
    if (failures >= FAILURE_THRESHOLD) {
      pausedUntil = now() + BACKOFF_MS;
      failures = 0;
    }
    return 'ask';
  };

  return {
    async evaluate(context: PermissionContext, signal?: AbortSignal): Promise<PermissionVerdict> {
      if (signal?.aborted === true) {
        return 'ask';
      }
      // 落ちていると分かっている間は round trip を張らない（待たせるだけ無駄）。
      if (now() < pausedUntil) {
        return 'ask';
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      // 取得中に終了されても、このタイマーがプロセスを生かし続けないように。
      timer.unref?.();
      try {
        const res = await fetchFn(`${baseUrl}${SYSTEM_ONE_PATH}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': userAgent,
          },
          body: JSON.stringify({
            state: toState(context),
            model,
            questions: {
              [QUESTION_KEY]: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA },
            },
          }),
          signal: controller.signal,
        });
        // 4xx / 5xx（キー切れ・レート制限・障害）は安全側へ。呼び出し側が `ask` にする。
        if (!res.ok) {
          return giveUp();
        }
        const verdict = toJevVerdict(await res.json(), allowThreshold);
        // 応答が読めた = 生きている。連続失敗のカウントを戻す。
        failures = 0;
        return verdict;
      } catch {
        // 通信断・締切による abort もここ（呼び出し側の締切は評価器から見ると abort）。
        return giveUp();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
