import { describe, expect, it } from 'vitest';
import {
  canSelfUpdate,
  compareVersions,
  type InstallKind,
  isUpdateAvailable,
  parseVersion,
  resolveUpdateCheck,
  updateCommandFor,
  updateCommandLine,
} from './update';

describe('parseVersion', () => {
  const cases: ReadonlyArray<[string, ReturnType<typeof parseVersion>]> = [
    ['1.2.3', { release: [1, 2, 3], prerelease: [] }],
    ['v1.2.3', { release: [1, 2, 3], prerelease: [] }],
    ['  0.2.9  ', { release: [0, 2, 9], prerelease: [] }],
    ['1.2.3+build.5', { release: [1, 2, 3], prerelease: [] }],
    ['1.2.3-beta.1', { release: [1, 2, 3], prerelease: ['beta', 1] }],
    ['1.2.3-rc.1+build', { release: [1, 2, 3], prerelease: ['rc', 1] }],
    ['1.2', { release: [1, 2], prerelease: [] }],
    ['latest', undefined],
    ['', undefined],
    ['1.x.3', undefined],
    ['^1.2.3', undefined],
  ];

  it.each(cases)('parses %j', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected);
  });
});

describe('compareVersions', () => {
  const cases: ReadonlyArray<[string, string, number]> = [
    // 等価
    ['1.2.3', '1.2.3', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.2.3+a', '1.2.3+b', 0],
    ['1.2.0', '1.2', 0],
    // release 部
    ['1.2.4', '1.2.3', 1],
    ['1.3.0', '1.2.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['0.2.9', '0.2.10', -1],
    ['0.10.0', '0.9.0', 1],
    // prerelease は正式リリースより小さい
    ['1.2.3', '1.2.3-beta.1', 1],
    ['1.2.3-beta.1', '1.2.3', -1],
    // prerelease 同士
    ['1.2.3-beta.2', '1.2.3-beta.1', 1],
    ['1.2.3-beta.10', '1.2.3-beta.2', 1],
    ['1.2.3-alpha', '1.2.3-beta', -1],
    ['1.2.3-1', '1.2.3-alpha', -1],
    ['1.2.3-beta.1', '1.2.3-beta', 1],
    // プレリリースは release 部の差に負ける
    ['1.3.0-beta.1', '1.2.9', 1],
    // 解釈できない値は差なし扱い
    ['latest', '1.2.3', 0],
    ['1.2.3', 'latest', 0],
    ['', '', 0],
  ];

  it.each(cases)('compares %s vs %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe('isUpdateAvailable', () => {
  const cases: ReadonlyArray<[string | undefined, string | undefined, boolean]> = [
    ['0.2.9', '0.3.0', true],
    ['0.2.9', '0.2.10', true],
    ['0.2.9', '0.2.9', false],
    ['0.3.0', '0.2.9', false],
    // 手元が prerelease で latest が正式版なら更新あり
    ['0.3.0-beta.1', '0.3.0', true],
    // 手元の prerelease が latest より新しければ勧めない
    ['0.4.0-beta.1', '0.3.0', false],
    [undefined, '0.3.0', false],
    ['0.2.9', undefined, false],
    [undefined, undefined, false],
    ['0.2.9', 'latest', false],
  ];

  it.each(cases)('current=%s latest=%s → %s', (current, latest, expected) => {
    expect(isUpdateAvailable(current, latest)).toBe(expected);
  });
});

describe('resolveUpdateCheck', () => {
  it('reports an available update with the package and install kind', () => {
    expect(
      resolveUpdateCheck({ pkg: 'codiva', current: '0.2.9', latest: '0.3.0', install: 'global' }),
    ).toEqual({
      kind: 'available',
      info: { pkg: 'codiva', current: '0.2.9', latest: '0.3.0', install: 'global' },
    });
  });

  it('reports up-to-date when the registry is not ahead', () => {
    expect(
      resolveUpdateCheck({ pkg: 'codiva', current: '0.3.0', latest: '0.3.0', install: 'global' }),
    ).toEqual({ kind: 'up-to-date', current: '0.3.0' });
    expect(
      resolveUpdateCheck({ pkg: 'codiva', current: '0.4.0', latest: '0.3.0', install: 'global' }),
    ).toEqual({ kind: 'up-to-date', current: '0.4.0' });
  });

  const unavailable: ReadonlyArray<[string | undefined, string | undefined]> = [
    [undefined, '0.3.0'],
    ['0.2.9', undefined],
    [undefined, undefined],
    // 壊れた値を「最新です」と言い切らない（オフライン等と同じ扱い）。
    ['0.2.9', 'latest'],
    ['dev', '0.3.0'],
  ];

  it.each(unavailable)('current=%s latest=%s → unavailable', (current, latest) => {
    expect(resolveUpdateCheck({ pkg: 'codiva', current, latest, install: 'global' })).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('updateCommandFor / updateCommandLine', () => {
  const cases: ReadonlyArray<[InstallKind, string | undefined]> = [
    ['global', 'npm install -g codiva@latest'],
    ['unknown', 'npm install -g codiva@latest'],
    ['local', 'npm install codiva@latest'],
    ['npx', undefined],
  ];

  it.each(cases)('%s → %s', (install, expected) => {
    expect(updateCommandLine(install, 'codiva')).toBe(expected);
  });

  it('returns argv form for execFile (never a shell string)', () => {
    expect(updateCommandFor('global', 'codiva')).toEqual({
      file: 'npm',
      args: ['install', '-g', 'codiva@latest'],
    });
  });
});

describe('canSelfUpdate', () => {
  // グローバルだけ実行を許す。`local` は利用者のリポジトリの package.json /
  // lockfile / node_modules を書き換えてしまうので提示だけに留める。
  const cases: ReadonlyArray<[InstallKind, boolean]> = [
    ['global', true],
    ['local', false],
    ['npx', false],
    ['unknown', false],
  ];

  it.each(cases)('%s → %s', (install, expected) => {
    expect(canSelfUpdate(install)).toBe(expected);
  });
});
