import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAvailability } from '@/core';
import { childProcessEnv } from './child-env';

const execFileAsync = promisify(execFile);

/**
 * Claude Code CLI が使える状態かを調べる（`AgentAdapter.checkAvailability` の実体）。
 *
 * - 導入: `claude --version` が 0 で返るか。
 * - ログイン: **keychain は読まない**（`security` は ACL 確認ダイアログを出すことがあり、
 *   起動時に走らせたくない）。分かるのは次のときだけで、それ以外は `'unknown'` に倒す
 *   （macOS の OAuth ログインは資格情報を keychain に置くので、`'unknown'` は普通に出る =
 *   「判定できない」であって「未ログイン」ではない）:
 *     - 認証系の環境変数（API キー / OAuth トークン / Bedrock・Vertex 経由）
 *     - Linux 等の資格情報ファイル `~/.claude/.credentials.json`
 *
 * throw しない。トークンの有効性は見ない（期限切れは実行時に `needs_login` で出る）。
 */
const PROBE_TIMEOUT_MS = 4000;

/** ログイン済みと断定してよい環境変数（どれか 1 つでもあれば true）。 */
const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/** Linux 等の資格情報ファイル（macOS は keychain なので存在しないことが多い）。 */
const CREDENTIALS_FILE = join('.claude', '.credentials.json');

export interface ClaudeAvailabilityOptions {
  command?: string;
  /** 認証判定に使う環境変数（既定 `process.env`）。テストで差し替える。 */
  env?: NodeJS.ProcessEnv;
  /** 資格情報ファイルの探索起点（既定 `os.homedir()`）。テストで差し替える。 */
  home?: string;
}

async function credentialsFilePresent(home: string): Promise<boolean> {
  try {
    const body = await readFile(join(home, CREDENTIALS_FILE), 'utf8');
    return body.trim().length > 0;
  } catch {
    return false;
  }
}

export async function detectClaudeAvailability(
  opts: ClaudeAvailabilityOptions = {},
): Promise<AgentAvailability> {
  const command = opts.command ?? 'claude';
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  const installed = await execFileAsync(command, ['--version'], {
    timeout: PROBE_TIMEOUT_MS,
    env: childProcessEnv(),
  })
    .then(() => true)
    .catch(() => false);
  if (!installed) {
    return { installed: false, loggedIn: false };
  }
  if (AUTH_ENV_KEYS.some((k) => (env[k] ?? '').trim().length > 0)) {
    return { installed: true, loggedIn: true };
  }
  if (await credentialsFilePresent(home)) {
    return { installed: true, loggedIn: true };
  }
  // keychain を見ないので、macOS の OAuth ログインは「不明」に落ちる（嘘はつかない）。
  return { installed: true, loggedIn: 'unknown' };
}
