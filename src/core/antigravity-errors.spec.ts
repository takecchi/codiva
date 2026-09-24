import { describe, expect, it } from 'vitest';
import { classifyAntigravityError } from '@/core/antigravity-errors';

/**
 * 分類の番人。**実測した文言**（agy 1.2.10）を先頭に置いてある — ここが崩れると
 * 認証切れが終端の `failed` になり、ログインし直せば直るセッションに
 * 再開の導線が出なくなる。
 */
describe('classifyAntigravityError', () => {
  it.each([
    // --- 実バイナリから採取した文言 ---
    ['authentication failed or timed out', 'auth'],
    ["Error: authentication required. Run 'agy' to log in, then retry.", 'auth'],
    [
      'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.',
      'auth',
    ],
    ['Error: authentication interrupted.', 'auth'],
    // --- 一般的な認証切れ ---
    ['invalid api key', 'auth'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['GEMINI_API_KEY environment variable is not set', 'auth'],
    // --- レート制限 ---
    ['rate limit exceeded', 'rate_limit'],
    ['RESOURCE_EXHAUSTED: quota exceeded', 'rate_limit'],
    ['You exceeded your current quota', 'rate_limit'],
    ['api error 429', 'rate_limit'],
    // --- 通信断（resumable） ---
    ['connection reset by peer', 'connection'],
    ['request timed out', 'connection'],
    ['deadline exceeded', 'connection'],
    ['HTTP 503 Service Unavailable', 'connection'],
    ['socket hang up', 'connection'],
    // --- 中断（失敗ではない） ---
    ['turn was canceled', 'connection'],
    ['operation was aborted', 'connection'],
    // --- 分からないものは終端 ---
    ['something went sideways', 'failed'],
    ['', 'failed'],
  ])('%j → %s', (text, cause) => {
    expect(classifyAntigravityError(text)).toBe(cause);
  });

  it('認証切れがタイムアウトに言及していても auth を優先する', () => {
    // 実測の文言そのもの。`timed out` を先に見ると通信断になり、
    // 「ログインし直せ」と言うべき場面で素の再開を勧めてしまう。
    expect(classifyAntigravityError('authentication failed or timed out')).toBe('auth');
  });

  it('レート制限は通信断より優先する', () => {
    expect(classifyAntigravityError('rate limit exceeded, connection closed')).toBe('rate_limit');
  });
});
