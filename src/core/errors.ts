/** A display string for an unknown catch value — the Error message, else String(). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Transport / connectivity failure signatures. A mid-stream query throw that
 * matches one of these is a *connection interruption* — the network dropped
 * while Claude was working (moving between networks, flaky wifi, a server
 * hiccup) rather than a genuine, unrecoverable error. Such a session can be
 * resumed (the SDK keeps the transcript), so we classify it as `interrupted`
 * instead of `failed` (see Session.consume / status-reducer `interrupted`).
 *
 * Kept deliberately broad on transport-level wording (socket/network/timeout,
 * common Node errno codes, and transient upstream 5xx / "overloaded") but never
 * matches ordinary application errors, which stay `failed`.
 */
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|enetunreach|ehostunreach|epipe/i,
  /socket hang up|getaddrinfo|network error|network request failed|fetch failed/i,
  /connection (?:error|closed|reset|refused|timed out|terminated)/i,
  /premature close|stream (?:error|closed)|terminated|read econn/i,
  /timeout|timed out/i,
  /\b(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable|overloaded/i,
];

/**
 * True when an error string looks like a network/connection interruption rather
 * than a real failure. Used to route a dropped-connection session to the
 * resumable `interrupted` state. See CONNECTION_ERROR_PATTERNS.
 */
export function isConnectionError(text: string): boolean {
  return CONNECTION_ERROR_PATTERNS.some((re) => re.test(text));
}
