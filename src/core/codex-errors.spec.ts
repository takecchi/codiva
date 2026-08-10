import { describe, expect, it } from 'vitest';
import { CODEX_RETRY_PREFIX, classifyCodexError, isCodexRetryNotice } from '@/core/codex-errors';
import type { AgentStopCause } from '@/core/types';

/** The token-refresh failure captured verbatim in `__fixtures__/codex-auth-error.jsonl`. */
const REFRESH_FAILED =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

describe('classifyCodexError', () => {
  // 順序に意味がある分類なので、境界（複数の分類に当たり得る文言）を必ず含める。
  const cases: [string, AgentStopCause][] = [
    // 認証切れは待っても再試行しても直らないので最優先。実文言は fixture 由来。
    [REFRESH_FAILED, 'auth'],
    ['Please run `codex login` to continue', 'auth'],
    ['not logged in', 'auth'],
    ['api error 401: Unauthorized', 'auth'],
    // 認証エラーがタイムアウトに言及しても通信断と読み違えない（Claude 側と同じ罠）。
    ['Your access token could not be refreshed: request timed out', 'auth'],

    // 使用量・レート制限は時間を置けば直る。
    ['rate limit: please slow down', 'rate_limit'],
    ['quota exceeded', 'rate_limit'],
    ['Quota exceeded. Check your plan and billing details.', 'rate_limit'],
    ['usage limit has been reached', 'rate_limit'],
    ['api error 429: Too Many Requests', 'rate_limit'],

    // 通信断・一過性の失敗は再開すれば続きから走る。
    ['stream disconnected before completion: mock upstream exploded', 'connection'],
    [
      'Reconnecting... 1/5 (stream disconnected before completion: mock upstream exploded)',
      'connection',
    ],
    ['http 500: internal server error', 'connection'],
    ['request timed out', 'connection'],
    ['server overloaded', 'connection'],
    ["We're currently experiencing high demand, which may cause temporary errors.", 'connection'],
    // 自分で止めたのだから失敗ではない（CLI 側の都合でこの文言が来た場合の受け皿）。
    ['turn aborted', 'connection'],

    // それ以外は本物の失敗（終端）。
    ['no such file or directory (os error 2)', 'failed'],
    ['', 'failed'],
  ];

  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(classifyCodexError(text)).toBe(expected);
  });
});

describe('isCodexRetryNotice', () => {
  it.each([
    'Reconnecting... 1/5 (stream disconnected before completion: mock upstream exploded)',
    'Reconnecting... 5/5 (stream disconnected before completion: mock upstream exploded)',
  ])('treats %j as a retry notice', (message) => {
    expect(isCodexRetryNotice(message)).toBe(true);
  });

  it.each([
    // 諦めたときに届く最終行。これは実況ではないので畳まず 1 行残す。
    'stream disconnected before completion: mock upstream exploded',
    REFRESH_FAILED,
    // 行頭でなければ実況ではない。
    'the tool suggested reconnecting the socket',
    '',
    // **大小・前置空白は許さない**（緩めてはいけない）: 畳み込み側のまとめ判定は
    // `startsWith(CODEX_RETRY_PREFIX)` で大小を区別するので、ここだけ緩いと
    // 「実況と判定したのにまとまらない」= リトライごとにログが 1 行ずつ増える。
    '  reconnecting to the model',
    'RECONNECTING',
  ])('does not treat %j as a retry notice', (message) => {
    expect(isCodexRetryNotice(message)).toBe(false);
  });

  it('shares its prefix with the coalesce key so the two can never drift', () => {
    expect(isCodexRetryNotice(`${CODEX_RETRY_PREFIX}... 1/5 (…)`)).toBe(true);
  });
});
