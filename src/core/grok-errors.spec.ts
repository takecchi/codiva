import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyGrokError,
  GROK_RETRY_PREFIX,
  grokErrorTypeCause,
  grokStopCause,
} from '@/core/grok-errors';
import { grokUpdateOf, toGrokMessage } from '@/core/grok-events';
import type { AgentStopCause } from '@/core/types';

/**
 * 失敗の分類。`auth` / `rate_limit` は状態機械では **resumable な idle** で、
 * ユーザーへの案内が別物（再ログイン / 待つ / 素の再開）なので取り違えられない。
 * 実測の文言（`__fixtures__/grok-autherror.jsonl`）を必ず含めてテーブルで固定する。
 */
describe('classifyGrokError', () => {
  it.each([
    // --- 認証（実測: 401 のレスポンス本文） ---
    [
      'Unauthorized (401) from http://127.0.0.1:8899/v1/responses: unauthenticated: Incorrect API key provided.',
      'auth',
    ],
    // --- 認証（実測: 未ログインで起動したとき） ---
    ['Not signed in. To authenticate without a browser, run: grok login --device-code', 'auth'],
    ['Authentication failed for the configured API key', 'auth'],
    ['invalid api key', 'auth'],
    ['HTTP 401 from https://api.x.ai/v1/responses', 'auth'],
    // --- レート制限 ---
    [
      'Too Many Requests (429) from https://api.x.ai/v1/responses: rate limit exceeded',
      'rate_limit',
    ],
    ['You exceeded your current quota, please check your plan and billing details', 'rate_limit'],
    ['usage limit reached for this model', 'rate_limit'],
    // --- 通信断・一過性（失敗ではなく中断として扱う） ---
    ['Service Unavailable (503) from https://api.x.ai/v1/responses', 'connection'],
    ['Bad Gateway (502) upstream', 'connection'],
    ['request timed out after 60s', 'connection'],
    ['stream disconnected before completion', 'connection'],
    ['connection reset by peer', 'connection'],
    ['ECONNRESET while reading the response', 'connection'],
    // --- 中止（ユーザー / クライアント都合。再開できる） ---
    ['The turn was cancelled', 'connection'],
    ['aborted by the client', 'connection'],
    // --- 分からないものは終端 ---
    ['something nobody has seen', 'failed'],
    ['', 'failed'],
    ['Internal error', 'failed'],
  ] as [string, AgentStopCause][])('%j を %s に分類する', (text, cause) => {
    expect(classifyGrokError(text)).toBe(cause);
  });

  it('認証切れを最優先で見る（タイムアウトに言及していても再ログインへ誘導する）', () => {
    // 通信断と読み違えると「そのまま再開」を勧めてしまい、永久に直らない。
    expect(
      classifyGrokError('Unauthorized (401): the session timed out, please sign in again'),
    ).toBe('auth');
  });
});

describe('grokErrorTypeCause', () => {
  it.each([
    ['auth', 'auth'],
    ['rate_limit', 'rate_limit'],
    ['network', 'connection'],
    ['connection', 'connection'],
  ] as [string, AgentStopCause][])('CLI の error_type %j を %s として尊重する', (type, cause) => {
    expect(grokErrorTypeCause(type)).toBe(cause);
  });

  it.each([
    // `api` は 4xx / 5xx を一緒くたにするので、ここで丸めず文言判定へ委ねる。
    ['api'],
    ['unknown'],
    [''],
    [undefined],
  ])('%j は文言判定へ委ねる（undefined）', (type) => {
    expect(grokErrorTypeCause(type)).toBeUndefined();
  });
});

describe('grokStopCause', () => {
  it('error_type があればそれを優先する（文言が無関係でも）', () => {
    expect(grokStopCause('something nobody has seen', 'auth')).toBe('auth');
    expect(grokStopCause('something nobody has seen', 'rate_limit')).toBe('rate_limit');
    // 文言はレート制限に見えるが、CLI は通信の問題だと言っている。
    expect(grokStopCause('rate limit exceeded', 'network')).toBe('connection');
  });

  it('error_type "api" の 401 は auth に落ちる（failed へ格下げしない）', () => {
    // ここが要点: `api` を素直に failed へ丸めると再ログインを促せなくなる。
    expect(
      grokStopCause(
        'Unauthorized (401) from https://api.x.ai/v1/responses: unauthenticated: Incorrect API key provided.',
        'api',
      ),
    ).toBe('auth');
    expect(grokStopCause('Service Unavailable (503)', 'api')).toBe('connection');
    expect(grokStopCause('Internal error', 'api')).toBe('failed');
  });

  it('error_type が無ければ文言だけで決める', () => {
    expect(grokStopCause('Too Many Requests (429)')).toBe('rate_limit');
    expect(grokStopCause('boom')).toBe('failed');
  });
});

describe('実データ（grok-autherror.jsonl）', () => {
  function retryState(): { errorType?: string; message: string } {
    const path = fileURLToPath(new URL('./__fixtures__/grok-autherror.jsonl', import.meta.url));
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const message = toGrokMessage(JSON.parse(line) as unknown);
      const update = message ? grokUpdateOf(message) : undefined;
      if (update?.sessionUpdate === 'retry_state') {
        return { errorType: update.error_type, message: update.message ?? '' };
      }
    }
    throw new Error('grok-autherror.jsonl carries no retry_state');
  }

  it('401 のターンは error_type / 文言のどちらから見ても auth', () => {
    const { errorType, message } = retryState();
    expect(errorType).toBe('auth');
    expect(message).toContain('Unauthorized (401)');
    expect(grokErrorTypeCause(errorType)).toBe('auth');
    expect(classifyGrokError(message)).toBe('auth');
    expect(grokStopCause(message, errorType)).toBe('auth');
  });

  it('JSON-RPC のエラー応答（data）も同じ分類になる', () => {
    const path = fileURLToPath(new URL('./__fixtures__/grok-autherror.jsonl', import.meta.url));
    const errors = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const message = toGrokMessage(JSON.parse(line) as unknown);
        return message?.kind === 'error' ? [message.error] : [];
      });
    expect(errors).toHaveLength(1);
    // `message` は "Internal error" で手がかりが無く、理由は `data` にしか無い。
    expect(classifyGrokError(errors[0]?.message ?? '')).toBe('failed');
    expect(classifyGrokError(String(errors[0]?.data ?? ''))).toBe('auth');
  });
});

describe('GROK_RETRY_PREFIX', () => {
  it('再試行の実況を畳むための接頭辞は安定した短い文字列', () => {
    expect(GROK_RETRY_PREFIX).toBe('retry:');
  });
});
