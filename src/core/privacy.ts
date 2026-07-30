/**
 * 学習データ利用（claude.ai の「Help improve our AI models」）の状態判定。純粋。
 *
 * この設定が ON のアカウントでは、Claude Code / codiva 経由の会話がモデル改善に
 * 使われうる。codiva は並列セッションで大量のコードを流すため、ONのまま気付かずに
 * 使い続けるのを防ぐ「気付き」を一覧画面に出す（判定できたときだけ・警告のみ）。
 *
 * 値の出所は 2 つあり、どちらも同じ `grove_enabled`（Anthropic 内部名 "grove"）を運ぶ:
 * - `~/.claude.json` の `groveConfigCache[accountUuid]`（Claude Code が書くキャッシュ）
 * - `GET /api/claude_code_grove`（非公開エンドポイント）
 *
 * I/O は `utils/privacy.ts`。ここは JSON → ドメイン値の変換だけを持つ。
 */

/**
 * 学習データ利用の状態。`'unknown'` は「判定できなかった」= 未ログイン・API キー利用・
 * キャッシュ無し・取得失敗のいずれか。**警告は `'on'` のときだけ出す**（不明で脅かさない）。
 */
export type TrainingOptIn = 'on' | 'off' | 'unknown';

/** キャッシュを信用する上限（7日）。これより古い値は `'unknown'` に丸めて再取得へ回す。 */
export const GROVE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `grove_enabled` を運ぶ JSON の共通形（API レスポンス / ローカルキャッシュ）。 */
interface GroveJson {
  grove_enabled?: unknown;
  /** ドメイン単位で対象外にされているか（API レスポンスのみ。意味は未検証）。 */
  domain_excluded?: unknown;
}

/** `~/.claude.json` のうち、学習データ利用の判定に使う部分だけの形。 */
interface ClaudeJson {
  oauthAccount?: unknown;
  groveConfigCache?: unknown;
}

/** キャッシュ 1 件の形（Claude Code が書く `{ grove_enabled, timestamp }`）。 */
interface GroveCacheEntryJson extends GroveJson {
  timestamp?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `grove_enabled` の真偽値をドメイン値へ。boolean 以外（null / 欠落）は `'unknown'`。 */
function toOptIn(value: unknown): TrainingOptIn {
  if (value === true) {
    return 'on';
  }
  if (value === false) {
    return 'off';
  }
  // Enterprise などポリシーで選択肢が無いアカウントは null が返る（実測）。
  return 'unknown';
}

/**
 * `GET /api/claude_code_grove` のレスポンス JSON → ドメイン値。
 * 壊れた JSON・想定外の形はすべて `'unknown'`（警告を出さない側に倒す）。
 */
export function toTrainingOptIn(json: unknown): TrainingOptIn {
  if (!isRecord(json)) {
    return 'unknown';
  }
  const { grove_enabled, domain_excluded } = json as GroveJson;
  // `domain_excluded` の正確な意味は未検証（`true` のとき Claude Code の設定ダイアログは
  // トグルを無効化する = ドメイン側で対象外にされている、と読める）。対象外なら
  // `grove_enabled: true` でも学習されない可能性があるため、警告を出さない側に倒す。
  if (domain_excluded === true) {
    return 'unknown';
  }
  return toOptIn(grove_enabled);
}

/**
 * `~/.claude.json` から学習データ利用の状態を読む（ネットワーク不要の高速パス）。
 *
 * キーは `oauthAccount.accountUuid`（実測）。**アカウントが読めないときに限り**、エントリが
 * ちょうど 1 件ならそれを採用する（accountUuid の形が変わっても効くように）。アカウントが
 * 分かっているのにエントリが無い場合は `'unknown'`: アカウント切替後に前のアカウントの
 * 設定を今のアカウントのものとして警告してしまうため（別アカウントの値を流用しない）。
 * `maxAgeMs` より古いエントリは `'unknown'` にして、呼び出し側の再取得へ委ねる。
 */
export function trainingOptInFromClaudeJson(
  json: unknown,
  now: number,
  maxAgeMs: number = GROVE_CACHE_MAX_AGE_MS,
): TrainingOptIn {
  if (!isRecord(json)) {
    return 'unknown';
  }
  const { oauthAccount, groveConfigCache } = json as ClaudeJson;
  if (!isRecord(groveConfigCache)) {
    return 'unknown';
  }
  const accountUuid = isRecord(oauthAccount) ? oauthAccount.accountUuid : undefined;
  const keys = Object.keys(groveConfigCache);
  const key =
    typeof accountUuid === 'string'
      ? accountUuid in groveConfigCache
        ? accountUuid
        : undefined
      : keys.length === 1
        ? keys[0]
        : undefined;
  if (key === undefined) {
    return 'unknown';
  }
  const entry = groveConfigCache[key];
  if (!isRecord(entry)) {
    return 'unknown';
  }
  const { grove_enabled, timestamp } = entry as GroveCacheEntryJson;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return 'unknown';
  }
  if (now - timestamp > maxAgeMs) {
    return 'unknown';
  }
  return toOptIn(grove_enabled);
}

/**
 * 一覧画面に警告を出すか。`'on'` と確定したときだけ true（`'unknown'` では出さない）。
 * 設定 `privacyWarning: false` で黙らせられる（判定自体も走らせない）。
 */
export function shouldWarnTraining(optIn: TrainingOptIn | undefined): boolean {
  return optIn === 'on';
}
