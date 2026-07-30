import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '@/core';
import {
  createUpdateService,
  fetchLatestVersion,
  installKindFor,
  npmGlobalRoot,
  packageRootFrom,
  resolveInstallKind,
  runUpdate,
  type UpdateExec,
} from './update';

/** `fetch` の最小フェイク。渡した body を JSON として返す。 */
function fakeFetch(body: unknown, init: { ok?: boolean } = {}): typeof fetch {
  return (async () => ({
    ok: init.ok ?? true,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('fetchLatestVersion', () => {
  it('reads dist-tags latest from the version document', async () => {
    await expect(
      fetchLatestVersion('codiva', { fetchImpl: fakeFetch({ version: '1.2.3' }) }),
    ).resolves.toBe('1.2.3');
  });

  it('trims and rejects unusable payloads', async () => {
    const cases: ReadonlyArray<[unknown, string | undefined]> = [
      [{ version: '  1.2.3  ' }, '1.2.3'],
      [{ version: '' }, undefined],
      [{ version: 42 }, undefined],
      [{}, undefined],
      [null, undefined],
      ['nope', undefined],
    ];
    for (const [body, expected] of cases) {
      await expect(fetchLatestVersion('codiva', { fetchImpl: fakeFetch(body) })).resolves.toBe(
        expected,
      );
    }
  });

  it('returns undefined on a non-ok response', async () => {
    await expect(
      fetchLatestVersion('codiva', { fetchImpl: fakeFetch({ version: '1.2.3' }, { ok: false }) }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the network fails', async () => {
    const boom = (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch;
    await expect(fetchLatestVersion('codiva', { fetchImpl: boom })).resolves.toBeUndefined();
  });

  it('gives up after the timeout instead of hanging', async () => {
    // abort されるまで解決しない fetch = オフラインで TCP が沈黙するケース。
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as unknown as typeof fetch;
    await expect(
      fetchLatestVersion('codiva', { fetchImpl: hang, timeoutMs: 5 }),
    ).resolves.toBeUndefined();
  });

  it('gives up when the caller aborts', async () => {
    const controller = new AbortController();
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as unknown as typeof fetch;
    const promise = fetchLatestVersion('codiva', { fetchImpl: hang, signal: controller.signal });
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('requests the registry version document for the package', async () => {
    const urls: string[] = [];
    const spy = (async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ version: '1.0.0' }) };
    }) as unknown as typeof fetch;
    await fetchLatestVersion('codiva', { fetchImpl: spy });
    expect(urls).toEqual(['https://registry.npmjs.org/codiva/latest']);
  });
});

describe('installKindFor', () => {
  const cases: ReadonlyArray<[string, Parameters<typeof installKindFor>[0], string]> = [
    [
      'global install under the node prefix (posix)',
      {
        packageRoot: '/usr/local/lib/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'darwin',
      },
      'global',
    ],
    [
      'global install under a version manager prefix',
      {
        packageRoot: '/home/u/.nvm/versions/node/v22.0.0/lib/node_modules/codiva',
        execPath: '/home/u/.nvm/versions/node/v22.0.0/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'global',
    ],
    [
      // Windows は `npm.cmd` をシェル無しで spawn できないので実行対象にしない。
      'windows never claims global (npm.cmd cannot be spawned without a shell)',
      {
        packageRoot: '/usr/local/lib/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'win32',
      },
      'unknown',
    ],
    [
      'npx cache',
      {
        packageRoot: '/home/u/.npm/_npx/1a2b3c/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'npx',
    ],
    [
      'pnpm dlx cache',
      {
        packageRoot: '/home/u/.cache/pnpm/dlx/abc123/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'npx',
    ],
    [
      'bunx cache',
      {
        packageRoot: '/home/u/.bun/install/cache/bunx-1000-codiva/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'npx',
    ],
    [
      // 部分一致だと誤検出する紛らわしいパス（`bunx-tools` は npx ではない）。
      'a directory merely starting with the npx marker is not a disposable run',
      {
        packageRoot: '/work/bunx-tools/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/other/repo',
        platform: 'linux',
      },
      'unknown',
    ],
    [
      // homebrew は Cellar 実体を指すため execPath からは導けない
      // （`resolveInstallKind` が `npm root -g` で拾い直す）。
      'homebrew global install is not derivable from execPath',
      {
        packageRoot: '/opt/homebrew/lib/node_modules/codiva',
        execPath: '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        cwd: '/work/repo',
        platform: 'darwin',
      },
      'unknown',
    ],
    [
      'local devDependency of the target repo',
      {
        packageRoot: '/work/repo/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'local',
    ],
    [
      'volta-managed install is not claimed (manual guidance instead)',
      {
        packageRoot: '/home/u/.volta/tools/image/packages/codiva/lib/node_modules/codiva',
        execPath: '/home/u/.volta/tools/image/node/22.0.0/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'unknown',
    ],
    [
      'running from source (npm run dev)',
      {
        packageRoot: '/home/u/projects/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/home/u/projects/codiva',
        platform: 'linux',
      },
      'unknown',
    ],
    [
      "another repo's node_modules is not this repo's local install",
      {
        packageRoot: '/work/other/node_modules/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      },
      'unknown',
    ],
  ];

  it.each(cases)('%s → %s', (_label, input, expected) => {
    expect(installKindFor(input)).toBe(expected);
  });

  it('treats a sibling directory as outside (no prefix-string false positive)', () => {
    expect(
      installKindFor({
        // `/work/repo/node_modules-old` は `/work/repo/node_modules` の中ではない。
        packageRoot: '/work/repo/node_modules-old/codiva',
        execPath: '/usr/local/bin/node',
        cwd: '/work/repo',
        platform: 'linux',
      }),
    ).toBe('unknown');
  });
});

describe('packageRootFrom', () => {
  it('resolves the package root from the bundle entry', () => {
    expect(packageRootFrom('file:///opt/app/dist/index.js')).toBe('/opt/app');
    expect(packageRootFrom('file:///opt/app/src/index.tsx')).toBe('/opt/app');
  });

  it('decodes percent-escaped paths', () => {
    expect(packageRootFrom('file:///opt/my%20app/dist/index.js')).toBe(join('/opt', 'my app'));
  });
});

describe('runUpdate', () => {
  const globalInfo: UpdateInfo = {
    pkg: 'codiva',
    current: '0.2.9',
    latest: '0.3.0',
    install: 'global',
  };

  it('runs npm with an argv array (never a shell string)', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: UpdateExec = async (file, args) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    await expect(runUpdate(globalInfo, { exec })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ file: 'npm', args: ['install', '-g', 'codiva@latest'] }]);
  });

  it('pins the global install to the home dir, not the target repo', async () => {
    const calls: string[] = [];
    const exec: UpdateExec = async (_file, _args, opts) => {
      calls.push(opts.cwd);
      return { stdout: '', stderr: '' };
    };
    await runUpdate(globalInfo, { exec });
    // 対象リポジトリの `.npmrc`（registry / prefix）で宛先を書き換えられないため。
    expect(calls).toEqual([homedir()]);
  });

  // local / npx / unknown は codiva からは実行しない（UI はコマンドの提示だけ）。
  // とくに local は利用者のリポジトリの package.json / lockfile を書き換えてしまう。
  it.each([['local'], ['npx'], ['unknown']] as const)(
    'refuses to install for %s',
    async (install) => {
      const exec = vi.fn();
      const result = await runUpdate(
        { ...globalInfo, install },
        { exec: exec as unknown as UpdateExec },
      );
      // 理由の文字列は作らない（UI がカタログの「理由不明」を出す）。
      expect(result).toEqual({ ok: false, detail: '' });
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it('surfaces the last stderr line on failure (never throws)', async () => {
    const exec: UpdateExec = async () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'npm warn deprecated foo\nnpm error code EACCES\nnpm error syscall mkdir',
      });
    };
    await expect(runUpdate(globalInfo, { exec })).resolves.toEqual({
      ok: false,
      detail: 'npm error syscall mkdir',
    });
  });

  it('falls back to the error message when there is no stderr', async () => {
    const exec: UpdateExec = async () => {
      throw new Error('spawn npm ENOENT');
    };
    await expect(runUpdate(globalInfo, { exec })).resolves.toEqual({
      ok: false,
      detail: 'spawn npm ENOENT',
    });
  });
});

describe('createUpdateService', () => {
  it('starts the initial check eagerly and re-checks on demand', async () => {
    let version = '0.3.0';
    const calls = { n: 0 };
    const fetchImpl = (async () => {
      calls.n += 1;
      return { ok: true, json: async () => ({ version }) };
    }) as unknown as typeof fetch;
    const service = createUpdateService({
      pkg: 'codiva',
      current: '0.2.9',
      install: 'global',
      fetchImpl,
    });
    await expect(service.initial).resolves.toEqual({
      kind: 'available',
      info: { pkg: 'codiva', current: '0.2.9', latest: '0.3.0', install: 'global' },
    });
    expect(calls.n).toBe(1);
    // /update は毎回問い合わせ直す（キャッシュしない）。
    version = '0.2.9';
    await expect(service.check()).resolves.toEqual({ kind: 'up-to-date', current: '0.2.9' });
    expect(calls.n).toBe(2);
  });

  it('reports unavailable when the registry cannot be reached', async () => {
    const service = createUpdateService({
      pkg: 'codiva',
      current: '0.2.9',
      install: 'global',
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    });
    await expect(service.check()).resolves.toEqual({ kind: 'unavailable' });
  });

  it('delegates install to the injected exec', async () => {
    const calls: string[] = [];
    const service = createUpdateService({
      pkg: 'codiva',
      current: '0.2.9',
      install: 'global',
      fetchImpl: fakeFetch({ version: '0.3.0' }),
      exec: async (file, args) => {
        calls.push([file, ...args].join(' '));
        return { stdout: '', stderr: '' };
      },
    });
    await expect(
      service.install({ pkg: 'codiva', current: '0.2.9', latest: '0.3.0', install: 'global' }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['npm install -g codiva@latest']);
  });
});

describe('npmGlobalRoot / resolveInstallKind', () => {
  it('asks npm for the global root, pinned to the home dir (not the target repo)', async () => {
    const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
    const exec: UpdateExec = async (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd });
      return { stdout: '/opt/homebrew/lib/node_modules\n', stderr: '' };
    };
    await expect(npmGlobalRoot(exec)).resolves.toBe('/opt/homebrew/lib/node_modules');
    expect(calls[0]?.file).toBe('npm');
    expect(calls[0]?.args).toEqual(['root', '-g']);
    // 対象リポジトリの .npmrc に prefix を書き換えられないよう cwd を固定する。
    expect(calls[0]?.cwd).toBe(homedir());
  });

  it.each([
    ['empty output', { stdout: '  \n', stderr: '' }],
    ['whitespace only', { stdout: '', stderr: '' }],
  ])('returns undefined for %s', async (_label, result) => {
    await expect(npmGlobalRoot(async () => result)).resolves.toBeUndefined();
  });

  it('never throws when npm is missing', async () => {
    await expect(
      npmGlobalRoot(async () => {
        throw new Error('spawn npm ENOENT');
      }),
    ).resolves.toBeUndefined();
  });

  it('upgrades unknown to global when npm reports that root', async () => {
    const exec: UpdateExec = async () => ({
      stdout: '/opt/homebrew/lib/node_modules',
      stderr: '',
    });
    await expect(
      resolveInstallKind('/opt/homebrew/lib/node_modules/codiva', 'unknown', {
        platform: 'darwin',
        exec,
      }),
    ).resolves.toBe('global');
  });

  it('stays unknown when the package is elsewhere', async () => {
    const exec: UpdateExec = async () => ({
      stdout: '/opt/homebrew/lib/node_modules',
      stderr: '',
    });
    await expect(
      resolveInstallKind('/home/u/projects/codiva', 'unknown', { platform: 'darwin', exec }),
    ).resolves.toBe('unknown');
  });

  it.each([['global'], ['local'], ['npx']] as const)(
    'never spawns npm when the static verdict is already %s',
    async (staticKind) => {
      const exec = vi.fn();
      await expect(
        resolveInstallKind('/whatever', staticKind, {
          platform: 'darwin',
          exec: exec as unknown as UpdateExec,
        }),
      ).resolves.toBe(staticKind);
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it('never spawns npm on windows (self-update is not attempted there)', async () => {
    const exec = vi.fn();
    await expect(
      resolveInstallKind('/whatever', 'unknown', {
        platform: 'win32',
        exec: exec as unknown as UpdateExec,
      }),
    ).resolves.toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });
});
