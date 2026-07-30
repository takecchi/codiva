import { describe, expect, it, type Mock, vi } from 'vitest';
import { type FetchLike, fetchTrainingOptIn, type KeychainReader } from './privacy';

const HOME = '/home/tester';
const NOW = 1_000_000_000;
const TOKEN = 'sk-ant-oat01-test';

/** grove キャッシュ入りの `~/.claude.json`。 */
function claudeJson(groveEnabled: boolean | null, timestamp = NOW) {
  return JSON.stringify({
    oauthAccount: { accountUuid: 'acct-1' },
    groveConfigCache: { 'acct-1': { grove_enabled: groveEnabled, timestamp } },
  });
}

function credentials(token = TOKEN) {
  return JSON.stringify({ claudeAiOauth: { accessToken: token } });
}

/** 指定パスだけ内容を返し、ほかは ENOENT 相当で落ちる readText。 */
function files(map: Record<string, string>) {
  return async (path: string) => {
    const hit = map[path];
    if (hit === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return hit;
  };
}

function okFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, json: async () => body });
}

/** 1 回目の fetch 呼び出しの URL とヘッダ（呼ばれていなければ失敗させる）。 */
function firstCall(fetchFn: Mock<FetchLike>): {
  url: string;
  headers: Record<string, string>;
} {
  const call = fetchFn.mock.calls.at(0);
  if (!call) {
    throw new Error('fetch was not called');
  }
  return { url: call[0], headers: call[1].headers };
}

/** 共通の DI: Linux（Keychain 無し）・環境変数なし・時刻固定。 */
function base(overrides: Partial<Parameters<typeof fetchTrainingOptIn>[0]> = {}) {
  return {
    home: HOME,
    platform: 'linux',
    env: {} as NodeJS.ProcessEnv,
    now: () => NOW,
    readText: files({}),
    readKeychain: async () => undefined,
    fetchFn: (() => {
      throw new Error('fetch must not be called');
    }) as unknown as FetchLike,
    ...overrides,
  };
}

describe('fetchTrainingOptIn: キャッシュ', () => {
  it('OFF のキャッシュはそのまま使い、ネットワークへ出ない', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    const got = await fetchTrainingOptIn(
      base({
        readText: files({ [`${HOME}/.claude.json`]: claudeJson(false) }),
        fetchFn,
      }),
    );
    expect(got).toBe('off');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ON のキャッシュは信用せず問い合わせで確認する（OFF に変えた直後に警告し続けない）', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: false }));
    const got = await fetchTrainingOptIn(
      base({
        readText: files({
          [`${HOME}/.claude.json`]: claudeJson(true),
          [`${HOME}/.claude/.credentials.json`]: credentials(),
        }),
        fetchFn,
      }),
    );
    expect(got).toBe('off');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('ON のキャッシュは確認が取れなければ据え置く（警告は出る）', async () => {
    const got = await fetchTrainingOptIn(
      base({
        readText: files({
          [`${HOME}/.claude.json`]: claudeJson(true),
          [`${HOME}/.claude/.credentials.json`]: credentials(),
        }),
        fetchFn: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(got).toBe('on');
  });

  it('null（選択不可アカウント）のキャッシュは probe へ落ちる', async () => {
    const got = await fetchTrainingOptIn(
      base({ readText: files({ [`${HOME}/.claude.json`]: claudeJson(null) }) }),
    );
    // トークンが無いので判定不能のまま。
    expect(got).toBe('unknown');
  });

  it('古いキャッシュは信用せず probe へ落ちる', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    const got = await fetchTrainingOptIn(
      base({
        readText: files({
          // 8 日前 = 上限（7 日）超え
          [`${HOME}/.claude.json`]: claudeJson(false, NOW - 8 * 24 * 60 * 60 * 1000),
          [`${HOME}/.claude/.credentials.json`]: credentials(),
        }),
        fetchFn,
      }),
    );
    expect(got).toBe('on');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('fetchTrainingOptIn: probe', () => {
  it('認証情報ファイルのトークンで問い合わせ、claude-cli の User-Agent を送る', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    const got = await fetchTrainingOptIn(
      base({
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn,
      }),
    );
    expect(got).toBe('on');
    const { url, headers } = firstCall(fetchFn);
    expect(url).toBe('https://api.anthropic.com/api/claude_code_grove');
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // claude-cli 前置きが無いと 403（実測）。ここが崩れると常に unknown になる。
    expect(headers['User-Agent']?.startsWith('claude-cli')).toBe(true);
  });

  it('macOS は Keychain のトークンを使う', async () => {
    const readKeychain: Mock<KeychainReader> = vi.fn(async () =>
      credentials('sk-ant-oat01-keychain'),
    );
    const fetchFn = vi.fn(okFetch({ grove_enabled: false }));
    const got = await fetchTrainingOptIn(base({ platform: 'darwin', readKeychain, fetchFn }));
    expect(got).toBe('off');
    expect(readKeychain.mock.calls.at(0)?.[0]).toBe('Claude Code-credentials');
    expect(firstCall(fetchFn).headers.Authorization).toBe('Bearer sk-ant-oat01-keychain');
  });

  it('Keychain 読み出しには必ずタイムアウトと signal を渡す（終了が返らなくなるのを防ぐ）', async () => {
    const controller = new AbortController();
    const readKeychain: Mock<KeychainReader> = vi.fn(async () => credentials());
    await fetchTrainingOptIn(
      base({
        platform: 'darwin',
        readKeychain,
        fetchFn: okFetch({ grove_enabled: false }),
        signal: controller.signal,
      }),
    );
    const call = readKeychain.mock.calls.at(0);
    expect(call?.[1].timeoutMs).toBeGreaterThan(0);
    expect(call?.[1].signal).toBe(controller.signal);
  });

  it('domain_excluded なら ON でも警告しない', async () => {
    const got = await fetchTrainingOptIn(
      base({
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn: okFetch({ grove_enabled: true, domain_excluded: true }),
      }),
    );
    expect(got).toBe('unknown');
  });

  it('Keychain が壊れた値を返したらファイルへフォールバックする', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    const got = await fetchTrainingOptIn(
      base({
        platform: 'darwin',
        readKeychain: async () => 'not json',
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn,
      }),
    );
    expect(got).toBe('on');
  });

  const failures: [string, FetchLike][] = [
    ['403（User-Agent 拒否など）', async () => ({ ok: false, json: async () => ({}) })],
    [
      'ネットワークエラー',
      async () => {
        throw new Error('offline');
      },
    ],
    ['想定外のレスポンス', okFetch({ unexpected: true })],
    [
      'JSON パース失敗',
      async () => ({
        ok: true,
        json: async () => {
          throw new Error('invalid json');
        },
      }),
    ],
  ];

  it.each(failures)('%s は unknown に丸める', async (_label, fetchFn) => {
    const got = await fetchTrainingOptIn(
      base({
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn,
      }),
    );
    expect(got).toBe('unknown');
  });

  it('トークンが無ければ問い合わせない', async () => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    expect(await fetchTrainingOptIn(base({ fetchFn }))).toBe('unknown');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('signal で打ち切れる', async () => {
    const controller = new AbortController();
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const promise = fetchTrainingOptIn(
      base({
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn,
        signal: controller.signal,
      }),
    );
    controller.abort();
    expect(await promise).toBe('unknown');
  });

  it('タイムアウトすると unknown', async () => {
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
    expect(
      await fetchTrainingOptIn(
        base({
          readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
          fetchFn,
          timeoutMs: 1,
        }),
      ),
    ).toBe('unknown');
  });
});

describe('fetchTrainingOptIn: claude.ai 以外の認証方式', () => {
  const envs: [string, NodeJS.ProcessEnv][] = [
    ['ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'sk-ant-api-x' }],
    ['ANTHROPIC_AUTH_TOKEN', { ANTHROPIC_AUTH_TOKEN: 'tok' }],
    ['ANTHROPIC_BASE_URL', { ANTHROPIC_BASE_URL: 'https://gateway.example' }],
    ['CLAUDE_CODE_USE_BEDROCK', { CLAUDE_CODE_USE_BEDROCK: '1' }],
    ['CLAUDE_CODE_USE_VERTEX', { CLAUDE_CODE_USE_VERTEX: '1' }],
  ];

  it.each(envs)('%s があれば問い合わせず unknown', async (_label, env) => {
    const fetchFn = vi.fn(okFetch({ grove_enabled: true }));
    const got = await fetchTrainingOptIn(
      base({
        env,
        readText: files({ [`${HOME}/.claude/.credentials.json`]: credentials() }),
        fetchFn,
      }),
    );
    expect(got).toBe('unknown');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('キャッシュに ON が残っていても、API キー利用なら警告しない', async () => {
    // 過去に claude.ai へログインした残骸で、API 経由（学習対象外）の利用者に
    // 誤った警告を出さないこと。
    const got = await fetchTrainingOptIn(
      base({
        env: { ANTHROPIC_API_KEY: 'sk-ant-api-x' },
        readText: files({ [`${HOME}/.claude.json`]: claudeJson(true) }),
      }),
    );
    expect(got).toBe('unknown');
  });
});
