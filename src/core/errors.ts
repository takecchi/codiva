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
 *
 * The last two entries cover the CLI's *own* synthesized wordings for a stream that
 * died mid-answer, which it reports as an assistant message prefixed `API Error:`
 * before ending the turn. The wordings (recovered from the CLI binary) are:
 *   `API Error: Connection closed mid-response. The response above may be incomplete.`
 *   `API Error: Server error mid-response. The response above may be incomplete.`
 *   `API Error: Response stalled mid-stream. The response above may be incomplete.`
 *   `API Error: Connection closed while thinking, before producing a response. Try again.`
 *   `API Error: Response stalled while thinking, before producing a response. Try again.`
 *   `API Error: Connection to the API was lost (ECONNRESET). This is usually temporary — try again.`
 * The `connection closed` ones already matched the pattern above; the new entries add
 * the `mid-response` / `mid-stream` / `stalled` / `lost` phrasings.
 *
 * Text matching is only the *fallback* here. The wording-independent signals are the
 * typed `error` kind on that assistant message (`isTransientApiErrorKind`) and the
 * `terminal_reason` / `api_error_status` pair on the result (`isTransientApiStatus`).
 */
const CONNECTION_ERROR_PATTERNS: readonly RegExp[] = [
  /econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|enetunreach|ehostunreach|epipe/i,
  /socket hang up|getaddrinfo|network error|network request failed|fetch failed/i,
  /connection (?:error|closed|reset|refused|timed out|terminated)/i,
  /premature close|stream (?:error|closed)|terminated|read econn/i,
  /timeout|timed out/i,
  /\b(?:502|503|504)\b|bad gateway|gateway timeout|service unavailable|overloaded/i,
  /\bmid-(?:response|stream)\b|connection to the api was lost/i,
  /response stalled|stalled while thinking/i,
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

/**
 * The `SDKAssistantMessageError` kinds that mean "the API call itself failed for a
 * transient reason". When the response stream dies (or the upstream is at capacity /
 * returns 5xx) the CLI synthesizes an assistant message flagged with one of these,
 * carrying the human-readable reason as its text — `API Error: Connection closed
 * mid-response. The response above may be incomplete.` — and ends the turn.
 *
 * Nothing is wrong with the work: the transcript is intact, so resuming continues
 * the same conversation. We route it to `interrupted` (idle & resumable) rather than
 * letting the roll-up `result` land on a green "Completed" for a truncated answer.
 *
 * This is the *primary* signal for such a stop — typed, so it is independent of the
 * CLI's wording and the user's locale (the same failure has half a dozen phrasings;
 * see CONNECTION_ERROR_PATTERNS for the text fallback).
 *
 * Deliberately NOT here:
 * - `max_output_tokens` — the CLI recovers from it by continuing the turn
 *   (`resumed_from_incomplete_thinking`), so it must not stop the session.
 * - `invalid_request` / `model_not_found` / `billing_error` — real, non-transient
 *   failures that retrying never fixes; they stay `failed`.
 * - `rate_limit` / auth kinds — they have their own dedicated states.
 * - `unknown` — too vague to promise a resume; the result's `terminal_reason` /
 *   `api_error_status` pair classifies it instead (`isTransientApiStatus`).
 */
const TRANSIENT_API_ERROR_KINDS: readonly string[] = ['server_error', 'overloaded'];

/**
 * True for an SDK assistant-message `error` kind that means "the API call failed
 * transiently — resume it" (see TRANSIENT_API_ERROR_KINDS).
 */
export function isTransientApiErrorKind(kind: unknown): boolean {
  return typeof kind === 'string' && TRANSIENT_API_ERROR_KINDS.includes(kind);
}

/**
 * True when the HTTP status of an *API-error turn* (`terminal_reason: 'api_error'`)
 * describes a transient failure worth resuming. Callers must have established the
 * turn ended on an API error first — this only judges the status.
 *
 * An explicit `null` means the request never got an HTTP response: the SDK documents
 * exactly that for connection-level failures ("error_status is null for connection
 * errors (e.g. timeouts) that had no HTTP response"), which is the `Connection closed
 * mid-response` case. Otherwise only 5xx, 408 (request timeout) and 429 count — a 4xx
 * like 400 (invalid request) never clears by retrying and stays `failed`. 429 normally
 * never reaches here (the rate-limit classifiers run first); it is listed so a missed
 * wording still lands on a resumable state.
 *
 * `undefined` (the field absent) is deliberately NOT transient: `api_error_status`
 * exists only on the SDK's *success* result variant, so on an `error_during_execution`
 * result its absence says nothing about the failure — treating that as "no HTTP
 * response" would make every error result resumable, including a hard 400.
 */
export function isTransientApiStatus(status: unknown): boolean {
  if (status === null) {
    return true;
  }
  return typeof status === 'number' && (status >= 500 || status === 408 || status === 429);
}
