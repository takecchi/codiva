import { describe, expect, it } from 'vitest';
import {
  classifyClaudeError,
  isAuthError,
  isAuthErrorKind,
  isConnectionError,
  isTransientApiErrorKind,
  isTransientApiStatus,
} from './claude-errors';

describe('isConnectionError', () => {
  it.each([
    'fetch failed',
    'terminated',
    'socket hang up',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:443',
    'request to https://api.anthropic.com failed, reason: ETIMEDOUT',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'Connection error.',
    'network error',
    'Premature close',
    'Error: 503 Service Unavailable',
    'Overloaded',
    'The operation timed out',
    // The CLI's own wordings for a stream that died after part of the answer had
    // already been delivered (recovered from the binary). It finalizes the partial
    // response as an `API Error:` assistant message and ends the turn.
    'API Error: Connection closed mid-response. The response above may be incomplete.',
    'API Error: Server error mid-response. The response above may be incomplete.',
    'API Error: Response stalled mid-stream. The response above may be incomplete.',
    'API Error: Connection closed while thinking, before producing a response. Try again.',
    'API Error: Response stalled while thinking, before producing a response. Try again.',
    'API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.',
  ])('classifies %j as a connection interruption', (text) => {
    expect(isConnectionError(text)).toBe(true);
  });

  it.each([
    'stream boom',
    'invalid x-api-key',
    'permission denied',
    'error_during_execution',
    "You've hit your usage limit",
    'TypeError: cannot read property of undefined',
    '',
  ])('does not misclassify a genuine failure %j', (text) => {
    expect(isConnectionError(text)).toBe(false);
  });
});

describe('isAuthError', () => {
  it.each([
    // The CLI's own wordings (recovered from the binary). The first is what a
    // codiva session gets, since the CLI treats it as non-interactive.
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Login expired · Please run /login',
    'Failed to authenticate. API Error: 401',
    'Your account does not have access to Claude. Please login again or contact your administrator.',
    'OAuth token revoked · Please run /login',
    'Not logged in · Please run /login',
    'Invalid API key · Fix external API key',
    'Authentication error · This may be a temporary network issue, please try again',
    'Your organization has disabled API key authentication · Run /login to sign in with your claude.ai account',
    'AWS credentials expired or invalid',
    'Google Cloud authentication failed',
    'Your apiKeyHelper script is failing · This usually means you need to re-authenticate with your provider',
    // Auth errors that reach us as a raw kind / thrown message.
    'authentication_failed',
    'oauth_org_not_allowed',
    'Failed to authenticate through the broker: boom',
    'invalid x-api-key',
    '401 Unauthorized',
  ])('classifies %j as an auth failure', (text) => {
    expect(isAuthError(text)).toBe(true);
  });

  it.each([
    // Ordinary failures and limits must keep their own classification.
    'error_during_execution',
    "You've hit your usage limit",
    'rate limit reached',
    'fetch failed',
    'socket hang up',
    'permission denied',
    'TypeError: cannot read property of undefined',
    'merge conflict in src/app.tsx',
    // Billing, not auth: no login fixes an empty credit balance.
    'Credit balance is too low',
    '',
  ])('does not misclassify %j as an auth failure', (text) => {
    expect(isAuthError(text)).toBe(false);
  });
});

describe('isAuthErrorKind', () => {
  it.each(['authentication_failed', 'oauth_org_not_allowed'])(
    'treats the SDK error kind %j as needing a login',
    (kind) => {
      expect(isAuthErrorKind(kind)).toBe(true);
    },
  );

  it.each([
    // Other SDKAssistantMessageError kinds keep their own handling: rate_limit has
    // its own state, server/overloaded errors are transient interruptions
    // (isTransientApiErrorKind), and billing errors are genuine failures.
    'rate_limit',
    'billing_error',
    'overloaded',
    'invalid_request',
    'model_not_found',
    'server_error',
    'unknown',
  ])('does not treat %j as an auth failure', (kind) => {
    expect(isAuthErrorKind(kind)).toBe(false);
  });

  it('is safe for non-string values', () => {
    expect(isAuthErrorKind(undefined)).toBe(false);
    expect(isAuthErrorKind(null)).toBe(false);
    expect(isAuthErrorKind(42)).toBe(false);
  });
});

describe('isTransientApiErrorKind', () => {
  it.each(['server_error', 'overloaded'])(
    'treats the SDK error kind %j as a resumable interruption',
    (kind) => {
      expect(isTransientApiErrorKind(kind)).toBe(true);
    },
  );

  it.each([
    // Auth and rate limits have their own dedicated states.
    'authentication_failed',
    'oauth_org_not_allowed',
    'rate_limit',
    // Real failures that retrying never fixes.
    'billing_error',
    'invalid_request',
    'model_not_found',
    // The CLI continues the turn after this one (max-output-tokens recovery), so
    // it must never stop the session.
    'max_output_tokens',
    // Too vague to promise a resume — the result's terminal_reason classifies it.
    'unknown',
  ])('does not treat %j as a transient API failure', (kind) => {
    expect(isTransientApiErrorKind(kind)).toBe(false);
  });

  it('is safe for non-string values', () => {
    expect(isTransientApiErrorKind(undefined)).toBe(false);
    expect(isTransientApiErrorKind(null)).toBe(false);
    expect(isTransientApiErrorKind(42)).toBe(false);
  });
});

describe('isTransientApiStatus', () => {
  it('treats an explicit null as a connection-level failure (no HTTP response)', () => {
    expect(isTransientApiStatus(null)).toBe(true);
  });

  it('does not treat an absent status as transient', () => {
    // The field only exists on the SDK's success result variant, so on an error
    // result its absence carries no information — assuming "no HTTP response" there
    // would make a hard 400 look resumable.
    expect(isTransientApiStatus(undefined)).toBe(false);
  });

  it.each([500, 502, 503, 504, 529, 408, 429])('treats %i as transient', (status) => {
    expect(isTransientApiStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])('treats %i as a real failure', (status) => {
    expect(isTransientApiStatus(status)).toBe(false);
  });

  it('is safe for non-numeric values', () => {
    expect(isTransientApiStatus('503')).toBe(false);
    expect(isTransientApiStatus({})).toBe(false);
  });
});

describe('classifyClaudeError', () => {
  // 順序に意味がある分類なので、境界（複数の分類に当たり得る文言）を必ず含める。
  const cases: [string, string][] = [
    // 認証切れは待っても再試行しても直らないので最優先。
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth'],
    ['invalid x-api-key', 'auth'],
    // タイムアウトに*言及する*認証エラーを通信断と読み違えない（実際にあった罠）。
    ['Failed to authenticate through the broker: request timed out', 'auth'],
    // 使用量・レート制限は待てば直る。
    ["Error: You've hit your limit", 'rate_limit'],
    ['rate limit exceeded', 'rate_limit'],
    // 通信断は再開すれば続きから走る。
    ['connection reset', 'connection'],
    [
      'API Error: Connection closed mid-response. The response above may be incomplete.',
      'connection',
    ],
    ['socket hang up', 'connection'],
    // それ以外は本物の失敗。
    ['Cannot find module ./foo', 'failed'],
    ['ENOENT: no such file or directory', 'failed'],
  ];

  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(classifyClaudeError(text)).toBe(expected);
  });
});
