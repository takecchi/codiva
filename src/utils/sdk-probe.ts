import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Shared plumbing for "ask the SDK a question, then get out": spin up one `claude`
 * subprocess in streaming-input mode, read the answers the init handshake and the
 * control channel can give (model catalog, account info, `/usage`), and abort.
 *
 * **No inference runs**, so a probe costs no tokens — but it is still a subprocess,
 * so every probe is short-lived, self-timing, and always aborted (see
 * .claude/rules/sdk-integration.md "サブプロセスのコスト意識").
 */

/** 起動を待たせないための上限。取れなければ呼び出し側がフォールバックする。 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The slice of the `query` handle a probe reads. Every method is optional so a
 * test fake only implements what it needs; the real `Query` (which declares them
 * all) is still assignable.
 */
export interface ProbeHandle extends AsyncIterable<unknown> {
  /** Selectable models for `/model` (`core/models.ts` converts the rows). */
  supportedModels?(): Promise<unknown>;
  /** The logged-in account: plan name, organization, API backend. */
  accountInfo?(): Promise<unknown>;
  /**
   * Structured `/usage` data (plan + rate-limit utilization). Experimental in the
   * SDK — the long name is the SDK's own; guarded as optional here so a future
   * rename degrades to "no windows" instead of a crash.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
}

/**
 * The `query` slice a probe calls. streaming-input mode (prompt is an
 * `AsyncIterable`) is required: the control-channel methods above only exist
 * there. The real `query` is assignable.
 */
export type ProbeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ProbeHandle;

export interface ProbeOptions {
  cwd: string;
  /** Cancels the probe from outside (the composition root aborts this on exit). */
  signal?: AbortSignal;
  /** Override the self-contained timeout (default {@link PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * 何も送らないプロンプト。probe は init / control channel だけで完結するため入力は
 * 不要で、待ち続けることで「入力待ちのまま」= モデル推論を一切走らせない状態を保つ。
 *
 * 待ちは abort で解ける。決して解決しない Promise にすると、この async generator は
 * `.return()` を完了できず、`for await … break` する消費者が永久に待つことになる。
 */
export async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Resolve `promise` with its value, or `undefined` if it rejects, is absent, or
 * doesn't settle within `ms`. Lets a probe read several independent control-channel
 * answers without one slow/absent answer discarding the others.
 *
 * The timer is unref'd, and a late rejection is swallowed rather than left unhandled.
 */
export async function settleWithin<T>(
  promise: Promise<T> | undefined,
  ms: number,
): Promise<T | undefined> {
  if (promise === undefined) {
    return undefined;
  }
  const settled = promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Run `read` against a throwaway probe session and return its value, or
 * `undefined` when the probe fails, times out, or is aborted (**never throws** —
 * probes are best-effort by contract, callers fall back).
 *
 * The subprocess is aborted on every exit path, including timeout: we decide the
 * deadline ourselves rather than trusting the SDK to reject on abort, so a
 * changed SDK internal can't leave the UI stuck on "loading".
 */
export async function runSdkProbe<T>(
  queryFn: ProbeQuery,
  opts: ProbeOptions,
  read: (handle: ProbeHandle) => Promise<T>,
): Promise<T | undefined> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const handle = queryFn({
      prompt: idlePrompt(abortController.signal),
      options: {
        cwd: opts.cwd,
        abortController,
        // probe は init と control channel しか読まないので、実セッションの設定
        // （`claudeSettingSources`）には追従せず最小構成で固定する。user 層まで読むと
        // ポーリングのたびにユーザーの hook が走る（`docs/TECH_NOTES.md`）。
        settingSources: ['project'],
      },
    });
    const answer = read(handle);
    // タイムアウト勝ちの後に届いた rejection を unhandled にしない。
    answer.catch(() => {});
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      answer,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
        // 取得中に終了されても、このタイマーがプロセスを生かし続けないように。
        timer.unref?.();
      }),
    ]);
    return result === timedOut ? undefined : result;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    opts.signal?.removeEventListener('abort', abort);
    // どの経路でも即座にサブプロセスを畳む（常駐させない）。
    abortController.abort();
  }
}
