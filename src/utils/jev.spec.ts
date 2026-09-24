import { describe, expect, it } from 'vitest';
import type { PermissionContext } from '@/core';
import { createJevEvaluator, type JevFetch, toJevVerdict } from './jev';

const CONTEXT: PermissionContext = {
  toolName: 'Bash',
  tool: 'shell',
  kind: 'tool',
  input: { command: 'npm test' },
  instruction: 'テストを通して',
  agent: 'claude',
};

/** `answers.gate` を組み立てる（公式ドキュメントの choice 応答の形）。 */
function answer(choice: string, allow: number, confidence = allow) {
  return {
    model: 'jev-1.13.0',
    answers: {
      gate: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { allow, ask: 1 - allow, deny: 0 },
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

/** 呼び出しを記録するフェイク fetch。 */
function fakeFetch(
  respond: (url: string, body: unknown) => { ok?: boolean; status?: number; json?: unknown },
) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchFn: JevFetch = async (url, init) => {
    const body = JSON.parse(init.body) as unknown;
    calls.push({ url, headers: init.headers, body });
    const res = respond(url, body);
    return {
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: async () => res.json,
    };
  };
  return { fetchFn, calls };
}

describe('toJevVerdict', () => {
  it.each<[string, unknown, number, string]>([
    ['confident allow', answer('allow', 0.97), 0.9, 'allow'],
    ['allow below the threshold falls back to ask', answer('allow', 0.7), 0.9, 'ask'],
    ['allow exactly at the threshold is taken', answer('allow', 0.9), 0.9, 'allow'],
    ['ask stays ask', answer('ask', 0.1), 0.9, 'ask'],
    ['deny is reported as deny (core promotes it to ask)', answer('deny', 0.0), 0.9, 'deny'],
    ['missing answers -> ask', { model: 'jev' }, 0.9, 'ask'],
    ['unknown choice -> ask', answer('maybe', 1), 0.9, 'ask'],
    ['non-object -> ask', 'nope', 0.9, 'ask'],
    ['null -> ask', null, 0.9, 'ask'],
  ])('%s', (_label, json, threshold, expected) => {
    expect(toJevVerdict(json, threshold)).toBe(expected);
  });

  it('falls back to `confidence` when the distribution is missing', () => {
    const json = { answers: { gate: { type: 'choice', choice: 'allow', confidence: 0.95 } } };
    expect(toJevVerdict(json, 0.9)).toBe('allow');
    expect(toJevVerdict(json, 0.99)).toBe('ask');
  });

  // 形が変わっても「勝手に走る」側へは落とさない。
  it('never allows when neither probabilities nor confidence are readable', () => {
    expect(toJevVerdict({ answers: { gate: { type: 'choice', choice: 'allow' } } }, 0)).toBe('ask');
  });
});

describe('createJevEvaluator', () => {
  it('is not created without an API key (existing behaviour stays untouched)', () => {
    expect(createJevEvaluator({ env: {} })).toBeUndefined();
    expect(createJevEvaluator({ env: { TYPESAFE_API_KEY: '   ' } })).toBeUndefined();
  });

  it('reads the API key from TYPESAFE_API_KEY (never from the config file)', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ json: answer('allow', 1) }));
    const evaluator = createJevEvaluator({ env: { TYPESAFE_API_KEY: 'k-1' }, fetchFn });
    await evaluator?.evaluate(CONTEXT);
    expect(calls[0]?.headers.Authorization).toBe('Bearer k-1');
  });

  it('posts a single typed choice question to /v1/systemone', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ json: answer('allow', 1) }));
    const evaluator = createJevEvaluator({ apiKey: 'k', fetchFn, env: {} });
    await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('allow');
    const call = calls[0];
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = call?.body as {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    expect(body.model).toBe('jev-latest');
    expect(body.questions.gate?.type).toBe('choice');
    expect(Object.keys(body.questions.gate?.criteria ?? {})).toEqual(['allow', 'ask', 'deny']);
    // 送るのは「文脈」だけ（`PermissionContext` は core 側で絞り込み済み）。
    expect(body.state).toEqual({
      tool_name: 'Bash',
      tool_kind: 'shell',
      tool_input: { command: 'npm test' },
      user_instruction: 'テストを通して',
      coding_agent: 'claude',
    });
  });

  it('honours baseUrl / model overrides and trims a trailing slash', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ json: answer('allow', 1) }));
    const evaluator = createJevEvaluator({
      apiKey: 'k',
      env: {},
      fetchFn,
      baseUrl: 'https://openrouter.ai/api/',
      model: 'jev-1.13',
    });
    await evaluator?.evaluate(CONTEXT);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(calls[0]?.body).toMatchObject({ model: 'jev-1.13' });
  });

  it('applies the configured allow threshold', async () => {
    const { fetchFn } = fakeFetch(() => ({ json: answer('allow', 0.8) }));
    const lenient = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn, allowThreshold: 0.5 });
    const strict = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn, allowThreshold: 0.95 });
    await expect(lenient?.evaluate(CONTEXT)).resolves.toBe('allow');
    await expect(strict?.evaluate(CONTEXT)).resolves.toBe('ask');
  });

  it.each([401, 429, 500])('falls back to ask on HTTP %s', async (status) => {
    const { fetchFn } = fakeFetch(() => ({ ok: false, status, json: undefined }));
    const evaluator = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn });
    await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('ask');
  });

  it('falls back to ask when the request throws (offline)', async () => {
    const fetchFn: JevFetch = () => Promise.reject(new Error('ENOTFOUND'));
    const evaluator = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn });
    await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('ask');
  });

  // オフライン・キー切れ・レート制限は次の 1 回でも直らないのに、毎ツールごとに
  // 締切ぶん待たされる。続くようなら問い合わせ自体を止める（判定は `ask` のままなので
  // 安全側は保たれる = 実質 `確認モード`）。
  it('stops calling out after repeated failures, and resumes after the backoff', async () => {
    let clock = 0;
    let healthy = false;
    const { fetchFn, calls } = fakeFetch(() =>
      healthy ? { json: answer('allow', 1) } : { ok: false, status: 500, json: undefined },
    );
    const evaluator = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn, now: () => clock });
    for (let i = 0; i < 10; i += 1) {
      await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('ask');
    }
    // 3 連敗で 60 秒止める。10 回叩いても round trip は 3 回だけ。
    expect(calls).toHaveLength(3);

    clock = 60_000;
    healthy = true;
    await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('allow');
    expect(calls).toHaveLength(4);
  });

  it('resets the failure count once a call succeeds', async () => {
    let healthy = false;
    const { fetchFn, calls } = fakeFetch(() =>
      healthy ? { json: answer('allow', 1) } : { ok: false, status: 500, json: undefined },
    );
    const evaluator = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn, now: () => 0 });
    await evaluator?.evaluate(CONTEXT);
    await evaluator?.evaluate(CONTEXT);
    healthy = true;
    await expect(evaluator?.evaluate(CONTEXT)).resolves.toBe('allow');
    healthy = false;
    // 連敗は途切れたので、また 3 回試せる（2 + 1 + 3）。
    for (let i = 0; i < 5; i += 1) {
      await evaluator?.evaluate(CONTEXT);
    }
    expect(calls).toHaveLength(6);
  });

  it('does not fire a request once the caller has aborted', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ json: answer('allow', 1) }));
    const evaluator = createJevEvaluator({ apiKey: 'k', env: {}, fetchFn });
    const controller = new AbortController();
    controller.abort();
    await expect(evaluator?.evaluate(CONTEXT, controller.signal)).resolves.toBe('ask');
    expect(calls).toHaveLength(0);
  });
});
