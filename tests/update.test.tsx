import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '@/app';
import { messages } from '@/core/i18n';
import type { UpdateCheck, UpdateInfo, UpdateRun, UpdateService } from '@/core/update';
import { flush, makeManager } from './helpers';

// Feature test for the update notification + `/update`, driven through the whole
// App. The pure comparison lives in src/core/update.spec.ts and the registry/npm
// I/O in src/utils/update.spec.ts; this covers the UI wiring: the banner line,
// the dialog's states, the y/n gate, and that keys never leak to the composer.

const m = messages.ja;

const availableInfo: UpdateInfo = {
  pkg: 'codiva',
  current: '0.2.9',
  latest: '0.3.0',
  install: 'global',
};

/** A fake UpdateService recording what the UI asked it to do. */
function fakeUpdater(
  check: UpdateCheck,
  opts: { run?: UpdateRun; initial?: UpdateCheck } = {},
): UpdateService & { installs: UpdateInfo[]; checks: number } {
  const state = { installs: [] as UpdateInfo[], checks: 0 };
  return {
    initial: Promise.resolve(opts.initial ?? check),
    check: async () => {
      state.checks += 1;
      return check;
    },
    install: async (info) => {
      state.installs.push(info);
      return opts.run ?? { ok: true };
    },
    get installs() {
      return state.installs;
    },
    get checks() {
      return state.checks;
    },
  };
}

/** Type `/update` and submit it. */
async function runUpdateCommand(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write('/update');
  await flush();
  stdin.write('\r');
  await flush();
}

describe('update notification (banner)', () => {
  it('shows a one-line notice when the registry is ahead', async () => {
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { lastFrame } = render(<App manager={makeManager()} version="0.2.9" updater={updater} />);
    await flush();
    expect(lastFrame() ?? '').toContain(m.update.available('0.3.0'));
    expect(lastFrame() ?? '').toContain(m.update.availableHint);
  });

  it.each([
    ['up-to-date', { kind: 'up-to-date', current: '0.2.9' } satisfies UpdateCheck],
    ['unavailable', { kind: 'unavailable' } satisfies UpdateCheck],
  ])('adds no banner line when the check reports %s', async (_label, check) => {
    const { lastFrame } = render(
      <App manager={makeManager()} version="0.2.9" updater={fakeUpdater(check)} />,
    );
    await flush();
    expect(lastFrame() ?? '').not.toContain(m.update.availableHint);
  });

  it('adds no banner line when no updater is injected', async () => {
    const { lastFrame } = render(<App manager={makeManager()} version="0.2.9" />);
    await flush();
    expect(lastFrame() ?? '').not.toContain(m.update.availableHint);
  });
});

describe('/update', () => {
  it('re-checks the registry and reports being up to date', async () => {
    const updater = fakeUpdater({ kind: 'up-to-date', current: '0.2.9' });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.upToDate('0.2.9'));
    // 起動時の結果を使い回さず、打つたびに問い合わせ直す。
    expect(updater.checks).toBe(1);
    // ダイアログはモーダルなので、まず任意キーで閉じてから打ち直す
    // （開いている間の入力はすべて飲まれる = 背後の入力欄が汚れない）。
    stdin.write('');
    await flush();
    await runUpdateCommand(stdin);
    expect(updater.checks).toBe(2);
  });

  it('asks before installing, then runs the update and tells the user to restart', async () => {
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.confirm('0.3.0', 'npm install -g codiva@latest'));
    expect(updater.installs).toEqual([]); // 確認前は絶対に実行しない
    stdin.write('y');
    await flush();
    expect(updater.installs).toEqual([availableInfo]);
    expect(lastFrame() ?? '').toContain(m.update.installed('0.3.0'));
  });

  it('n cancels without touching npm', async () => {
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    stdin.write('n');
    await flush();
    expect(updater.installs).toEqual([]);
    expect(lastFrame() ?? '').not.toContain(m.update.title);
  });

  it('surfaces a failed install instead of throwing', async () => {
    const updater = fakeUpdater(
      { kind: 'available', info: availableInfo },
      { run: { ok: false, detail: 'npm error code EACCES' } },
    );
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    stdin.write('y');
    await flush();
    expect(lastFrame() ?? '').toContain(m.update.failed('npm error code EACCES'));
  });

  it('never installs for an npx run — it just explains', async () => {
    const info: UpdateInfo = { ...availableInfo, install: 'npx' };
    const updater = fakeUpdater({ kind: 'available', info });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.npx('0.3.0'));
    // y は確認キーではなく「閉じる」— npx で npm install を走らせてはいけない。
    stdin.write('y');
    await flush();
    expect(updater.installs).toEqual([]);
    expect(lastFrame() ?? '').not.toContain(m.update.title);
  });

  it('only shows the manual command when the install route is unknown', async () => {
    const info: UpdateInfo = { ...availableInfo, install: 'unknown' };
    const updater = fakeUpdater({ kind: 'available', info });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.manual('0.3.0', 'npm install -g codiva@latest'));
    stdin.write('y');
    await flush();
    expect(updater.installs).toEqual([]);
  });

  it('reports an unreachable registry as unknown, not as up to date', async () => {
    const updater = fakeUpdater({ kind: 'unavailable' });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.unavailable);
  });

  it('says nothing could be checked when no updater is injected (no network)', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.unavailable);
  });

  it('closes on any key and swallows it (never leaks into the composer)', async () => {
    const updater = fakeUpdater({ kind: 'up-to-date', current: '0.2.9' });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    stdin.write('x');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(m.update.title);
    // ダイアログを閉じたキーが入力欄に残らない（プレースホルダのまま）。
    expect(frame).toContain(m.list.promptPlaceholder);
  });

  it('keeps Esc working while npm install runs (the TUI must never lock up)', async () => {
    // `/exit` は入力欄からしか打てず Ctrl+C も拾わないので、実行中に全キーを飲むと
    // インストールが終わるまで（最長 3 分）操作不能になる。Esc は必ず通す。
    const updater: UpdateService = {
      initial: Promise.resolve({ kind: 'available', info: availableInfo }),
      check: async () => ({ kind: 'available', info: availableInfo }),
      // 決して解決しない = ネットワークが沈黙した npm install。
      install: () => new Promise<UpdateRun>(() => {}),
    };
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await runUpdateCommand(stdin);
    stdin.write('y');
    await flush();
    expect(lastFrame() ?? '').toContain(m.update.installing);
    stdin.write('\x1b');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain(m.update.installing);
    expect(frame).toContain(m.list.promptPlaceholder);
  });

  it('clears the banner notice once the update is applied', async () => {
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { stdin, lastFrame } = render(<App manager={makeManager()} updater={updater} />);
    await flush();
    expect(lastFrame() ?? '').toContain(m.update.availableHint);
    await runUpdateCommand(stdin);
    stdin.write('y');
    await flush();
    // 実行中プロセスは旧版のままなので、案内は「再起動してください」に一本化する。
    expect(lastFrame() ?? '').toContain(m.update.installed('0.3.0'));
    expect(lastFrame() ?? '').not.toContain(m.update.availableHint);
  });

  it('warns when sessions are still running, without blocking the update', async () => {
    const manager = makeManager();
    manager.create('keep working'); // noopSession stays in 'creating' = active
    await flush();
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { stdin, lastFrame } = render(<App manager={manager} updater={updater} />);
    await runUpdateCommand(stdin);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(m.update.activeWarning(1));
    // 警告は出すがブロックはしない。
    expect(frame).toContain(m.action.confirmRun);
  });

  // モーダルの相互排他について。`PermissionDialog` は自前の `useInput` を持ち、Ink は
  // 1 つの入力チャンクを**マウント中の全ハンドラ**へ配る。両方出ていると更新確認の `y`
  // が未読のツール実行の許可も兼ねてしまうため、`pending` の導出に `!update` を入れて
  // **構造的に**同時マウントを禁じ、さらにモーダル中はマウスレポートも飲んでいる
  // （クリックで focus が list に移ると許可ダイアログが立つ経路を塞ぐ）。マウスの
  // 当たり判定はレイアウト実測に依存し ink-testing-library では再現できないので、
  // ここではレポート列が**生テキストとして漏れず、ダイアログを閉じない**ことを固定する。
  it('never lets stray mouse reports leak as text or dismiss the dialog', async () => {
    const manager = makeManager();
    manager.create('first task');
    manager.create('second task');
    await flush();
    const updater = fakeUpdater({ kind: 'available', info: availableInfo });
    const { stdin, lastFrame } = render(<App manager={manager} updater={updater} />);
    await runUpdateCommand(stdin);
    expect(lastFrame() ?? '').toContain(m.update.title);
    for (const report of ['\x1b[<64;5;5M', '\x1b[<65;5;5M', '\x1b[<0;5;5M', '\x1b[<0;5;5m']) {
      stdin.write(report);
      await flush();
    }
    const frame = lastFrame() ?? '';
    // 確認は生きたまま（マウスで誤って閉じない）。
    expect(frame).toContain(m.update.title);
    expect(frame).toContain(m.action.confirmRun);
    // エスケープ列が入力欄や画面に文字として現れない。
    expect(frame).not.toContain('[<64');
    expect(frame).not.toContain('[<0');
    // 続けて y を押せば通常どおり更新が走る（キー処理が壊れていない）。
    stdin.write('y');
    await flush();
    expect(updater.installs).toEqual([availableInfo]);
  });

  it('does not create a session for the bare `update` input', async () => {
    const manager = makeManager();
    const updater = fakeUpdater({ kind: 'up-to-date', current: '0.2.9' });
    const { stdin, lastFrame } = render(<App manager={manager} updater={updater} />);
    stdin.write('update');
    await flush();
    // 予告がパレットに出る（無言で走らない）。
    expect(lastFrame() ?? '').toContain(m.command.update);
    stdin.write('\r');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0);
    expect(updater.checks).toBe(1);
  });
});
