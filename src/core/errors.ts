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

/**
 * Authentication-failure signatures. The Claude CLI stops a turn with one of
 * these when its credentials are gone or stale — for a codiva session (which the
 * CLI treats as non-interactive) that is most often
 * `Failed to authenticate: OAuth session expired and could not be refreshed`,
 * i.e. the OAuth login simply aged out and could not be refreshed.
 *
 * This is neither a completion nor a real failure of the *task*: nothing is wrong
 * with the worktree or the prompt, the user just has to log in again (`claude` →
 * `/login`) and resume. So we route it to the dedicated `needs_login` state,
 * which tells the user what to do instead of showing a green "Completed" badge
 * for work that never ran.
 *
 * This is the *fallback* classifier, for text that reaches us without structure
 * (a thrown error from the query, an `errors[]` entry). The primary signal is the
 * SDK's own typed `SDKAssistantMessageError` — see `isAuthErrorKind` — which is
 * language-independent and covers every variant the CLI can emit. The patterns
 * here mirror the CLI's actual wordings (OAuth expired/revoked, bad or missing
 * API key, expired cloud credentials, "run /login", re-authenticate) while
 * staying narrow enough that ordinary application errors — and Claude merely
 * *writing about* authentication — stay `failed`.
 */
const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /failed to authenticate|authentication failed|not authenticated|unauthenticated/i,
  /re-?authenticate|please (?:re-?)?log ?in again/i,
  /oauth[^\n]{0,40}(?:expired|invalid|revoked|refresh)/i,
  /authentication[ _]error|authentication_failed|oauth_org_not_allowed|invalid_api_key/i,
  /(?:invalid|missing|expired|revoked)\s+(?:x-)?api[- ]key/i,
  /(?:session|token|credential)s?[^\n]{0,20}expired/i,
  /please (?:re-?)?(?:run|log ?in)[^\n]{0,20}\/login|run `?\/login`?/i,
  /\bunauthorized\b|\b401\b/i,
];

/**
 * True when an error string signals that Claude could not authenticate — the
 * user needs to log in again before this session can continue. Used to route the
 * session to `needs_login` (see AUTH_ERROR_PATTERNS).
 */
export function isAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERNS.some((re) => re.test(text));
}

/**
 * The `SDKAssistantMessageError` kinds that mean "this session cannot continue
 * until the user authenticates again". This is the *primary* auth signal: the SDK
 * sets it as a typed field on the assistant message (alongside the human-readable
 * text), so it is independent of the CLI's wording and of the user's locale.
 *
 * `oauth_org_not_allowed` is included because it is equally fatal and equally
 * fixable only by signing in differently (with an API key or after an admin
 * enables access) — the user has to go and deal with credentials either way.
 * `billing_error` (low credit balance) is deliberately NOT here: no login fixes
 * it, so it stays a plain `failed`.
 */
const AUTH_ERROR_KINDS: readonly string[] = ['authentication_failed', 'oauth_org_not_allowed'];

/** True for an SDK assistant-message `error` kind that means "log in again". */
export function isAuthErrorKind(kind: unknown): boolean {
  return typeof kind === 'string' && AUTH_ERROR_KINDS.includes(kind);
}
