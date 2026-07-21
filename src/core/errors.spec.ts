import { describe, expect, it } from 'vitest';
import { errorMessage, isConnectionError } from '@/core/errors';

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
