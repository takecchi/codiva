import { describe, expect, it } from 'vitest';
import { errorMessage, isAuthError, isAuthErrorKind, isConnectionError } from '@/core/errors';

describe('errorMessage', () => {
  it('uses an Error message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
  });
});

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
    // its own state, and billing/server errors are genuine failures.
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
