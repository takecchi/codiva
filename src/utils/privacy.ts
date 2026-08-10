import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type TrainingOptIn, toTrainingOptIn, trainingOptInFromClaudeJson } from '@/core';
import { childProcessEnv } from './child-env';

/**
 * 学習データ利用（claude.ai の「Help improve our AI models」）の状態を調べる I/O。
 * 判定ロジックは純粋な `core/privacy.ts`、ここは「どこから読むか」だけを持つ。
 *
 * 2 段構えで、**必ず安いほうから**試す:
 *  1. `~/.claude.json` の `groveConfigCache`（Claude Code が書くキャッシュ。ネットワークも
 *     認証情報も不要）
 *  2. `GET /api/claude_code_grove`（キャッシュが無い / 古いときだけ）
 *
 * 2 については Claude Code の非公開エンドポイントで、**User-Agent が `claude-cli` で
 * 始まらないと 403**（実測。`codiva/x.y.z` も `curl/*` も Forbidden）。仕様変更で壊れうる
 * ため、失敗はすべて `'unknown'` に丸めて黙る = 誤った警告を出さない。詳細は
 * docs/TECH_NOTES.md「学習データ利用（grove）の検知」。
 */

const execFileAsync = promisify(execFile);

/** Claude Code の OAuth 認証情報が入る macOS Keychain の service 名（実測）。 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Keychain が使えない環境（Linux 等）の認証情報ファイル。 */
const CREDENTIALS_FILE = join('.claude', '.credentials.json');
/** Claude Code のユーザーグローバル状態（`groveConfigCache` を含む）。 */
const CLAUDE_JSON = '.claude.json';
const API_BASE_URL = 'https://api.anthropic.com';
const GROVE_PATH = '/api/claude_code_grove';
/**
 * `claude-cli` 前置きが必須（それ以外は 403）。codiva だと分かる形にしつつ、
 * エンドポイントが受け付ける最小の形にしている。
 */
const USER_AGENT = 'claude-cli (external, codiva)';
/** 問い合わせの上限。取れなければ警告を出さないだけ。 */
const PROBE_TIMEOUT_MS = 5000;
/**
 * Keychain 読み出しの上限。`security` は Keychain がロックされていたり ACL の確認
 * ダイアログが出ると戻ってこないことがあり、生きた子プロセスはイベントループを掴む
 * （= 終了してもシェルのプロンプトが返らない）。必ず自前で決着させる。
 */
const KEYCHAIN_TIMEOUT_MS = 2000;

/** `fetch` の必要な部分だけの形（テストでフェイクを注入するため）。 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Keychain 読み出し（テストで差し替える）。abort / タイムアウトを受け取れる形にする。 */
export type KeychainReader = (
  service: string,
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<string | undefined>;

export interface TrainingOptInOptions {
  /** 認証方式の判定に使う環境変数（既定 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** ホームディレクトリ（既定 `os.homedir()`）。 */
  home?: string;
  /** `process.platform`。`'darwin'` のときだけ Keychain を見る。 */
  platform?: string;
  /** 終了時に取得を打ち切るためのシグナル（合成ルートが渡す）。 */
  signal?: AbortSignal;
  /** キャッシュの鮮度判定に使う現在時刻（既定 `Date.now`）。 */
  now?: () => number;
  timeoutMs?: number;
  readText?: (path: string) => Promise<string>;
  readKeychain?: KeychainReader;
  fetchFn?: FetchLike;
}

/**
 * macOS Keychain から秘密を読む。失敗（項目無し・拒否・タイムアウト・abort）は undefined。
 * `timeout` / `signal` を必ず渡し、子プロセスを残さない（終了が返らなくなるため）。
 */
const keychainSecret: KeychainReader = async (service, { signal, timeoutMs }) => {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { signal, timeout: timeoutMs, env: childProcessEnv() },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

/** JSON ファイルを読んでパースする。無い・壊れているは undefined（throw しない）。 */
async function readJson(
  path: string,
  readText: (path: string) => Promise<string>,
): Promise<unknown> {
  try {
    return JSON.parse(await readText(path)) as unknown;
  } catch {
    return undefined;
  }
}

function accessTokenOf(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) {
    return undefined;
  }
  const oauth = (json as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (typeof oauth !== 'object' || oauth === null) {
    return undefined;
  }
  const token = (oauth as { accessToken?: unknown }).accessToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * claude.ai サブスクリプションの OAuth トークンを取り出す。macOS は Keychain、
 * それ以外（と Keychain が空のとき）は `~/.claude/.credentials.json`。
 */
async function readAccessToken(opts: {
  home: string;
  platform: string;
  signal?: AbortSignal;
  readText: (path: string) => Promise<string>;
  readKeychain: KeychainReader;
}): Promise<string | undefined> {
  const raw =
    opts.platform === 'darwin'
      ? await opts.readKeychain(KEYCHAIN_SERVICE, {
          signal: opts.signal,
          timeoutMs: KEYCHAIN_TIMEOUT_MS,
        })
      : undefined;
  if (raw !== undefined) {
    const token = accessTokenOf(safeParse(raw));
    if (token !== undefined) {
      return token;
    }
  }
  return accessTokenOf(await readJson(join(opts.home, CREDENTIALS_FILE), opts.readText));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * この設定が意味を持つ認証方式か。API キー / Bedrock / Vertex / 独自ゲートウェイ経由の
 * 利用は claude.ai アカウント設定と無関係（かつ API 利用はモデル学習の対象外）なので、
 * 問い合わせずに `'unknown'` で終える。
 */
function isClaudeAiAuth(env: NodeJS.ProcessEnv): boolean {
  const set = (name: string) => (env[name] ?? '').length > 0;
  return !(
    set('ANTHROPIC_API_KEY') ||
    set('ANTHROPIC_AUTH_TOKEN') ||
    set('ANTHROPIC_BASE_URL') ||
    set('CLAUDE_CODE_USE_BEDROCK') ||
    set('CLAUDE_CODE_USE_VERTEX')
  );
}

/** 非公開エンドポイントへ 1 回だけ問い合わせる。失敗はすべて `'unknown'`。 */
async function probe(
  token: string,
  opts: { fetchFn: FetchLike; timeoutMs: number; signal?: AbortSignal },
): Promise<TrainingOptIn> {
  // すでに abort 済み（キャッシュ読みの間に終了された）なら問い合わせない。
  // addEventListener は abort 済みのシグナルでは発火しないので、この先手のチェックが
  // ないとタイムアウトまで待つことになる。
  if (opts.signal?.aborted === true) {
    return 'unknown';
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, opts.timeoutMs);
  // 取得中に終了されても、このタイマーがプロセスを生かし続けないように。
  timer.unref?.();
  try {
    const res = await opts.fetchFn(`${API_BASE_URL}${GROVE_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    return res.ok ? toTrainingOptIn(await res.json()) : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

/**
 * 学習データ利用の状態を返す。**throw しない**（判定できなければ `'unknown'`）。
 * 呼び出し側は `'on'` のときだけ警告を出す（`core/privacy.ts` の `shouldWarnTraining`）。
 */
export async function fetchTrainingOptIn(opts: TrainingOptInOptions = {}): Promise<TrainingOptIn> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const readText = opts.readText ?? ((path: string) => readFile(path, 'utf8'));
  const readKeychain = opts.readKeychain ?? keychainSecret;

  // claude.ai の設定と無関係な認証方式（API キー / Bedrock / Vertex / 独自ゲートウェイ）では
  // 何も答えない。**キャッシュより先に**弾く: 過去に claude.ai へログインした残骸が
  // `'on'` を返し、API 経由（学習対象外）で使っている人に誤った警告を出してしまうため。
  if (!isClaudeAiAuth(env)) {
    return 'unknown';
  }
  const cached = trainingOptInFromClaudeJson(
    await readJson(join(home, CLAUDE_JSON), readText),
    now(),
  );
  // `'off'` はキャッシュを信用してここで終える（ネットワークも認証情報も触らない）。
  // `'on'` は信用しない: ユーザーが claude.ai 側で OFF にしてもこのキャッシュは書き換わらず、
  // 「言われた通り切ったのに警告が出続ける」ことになる。問い合わせで確認し、確認が
  // 取れなかったときだけキャッシュの `'on'` にフォールバックする。
  if (cached === 'off') {
    return 'off';
  }
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const token = await readAccessToken({
    home,
    platform: opts.platform ?? process.platform,
    signal: opts.signal,
    readText,
    readKeychain,
  });
  if (token === undefined) {
    return cached;
  }
  const probed = await probe(token, {
    fetchFn,
    timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    signal: opts.signal,
  });
  // 問い合わせが決着しなければキャッシュ（`'on'` か `'unknown'`）を返す。
  return probed === 'unknown' ? cached : probed;
}
