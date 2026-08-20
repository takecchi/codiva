import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { COMMANDS } from '@/core/commands';
import type { CodivaConfig } from '@/core/config';
import { messages } from '@/core/i18n';
import { SessionManager } from '@/core/session-manager';
import { reduce } from '@/core/status-reducer';
import {
  fakeWorktrees,
  flush,
  makeManager,
  noopSession,
  renderFullscreen,
  settle,
  stripAnsi,
} from './helpers';

/**
 * A manager whose sessions land in a terminal state as soon as they start — the
 * only thing `/clear` acts on (`makeManager`'s sessions stay in `creating`).
 */
function makeFinishedManager(): SessionManager {
  return new SessionManager({
    worktrees: fakeWorktrees,
    queryFn: (() => {
      throw new Error('unused');
    }) as never,
    now: () => 0,
    createSession: ({ input, onChange }) => {
      const session = noopSession(input);
      session.start = () => {
        session.state = reduce(session.state, { kind: 'interrupted', at: 0 });
        onChange(session.state);
      };
      return session;
    },
  });
}

// Feature test for slash commands driven through the whole App. Pure parsing is
// unit-tested in src/core/commands.spec.ts; this checks the UI wiring: the
// palette, /help overlay, /exit, and the unknown-command error.

describe('slash commands', () => {
  it('shows the command palette while typing a leading slash', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(messages.ja.command.paletteTitle);
    expect(frame).toContain('/model');
    expect(frame).toContain('/config');
  });

  // コマンドが 14 個になった時点で、24 行の端末では全件が入らなくなった（Yoga が
  // パレットの枠自体を縮め、`/help` の行が消えてフッタと `/exit` が重なって描かれた）。
  // 入り切らないぶんは黙って捨てず「他 N 件」に畳み、枠は壊さない。
  it('低い端末では入り切らないコマンドを「他 N 件」に畳む（枠は潰さない）', async () => {
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={makeManager()} />, 24, 100);
    stdin.write('/');
    await flush();
    const lines = stripAnsi(lastFrame()).split('\n');
    const shown = lines.filter((l) => /\s\/[a-z-]+\s{2,}/.test(l)).length;
    expect(shown).toBeLessThan(COMMANDS.length);
    expect(
      lines.some((l) => l.includes(messages.ja.command.paletteMore(COMMANDS.length - shown))),
    ).toBe(true);
    // 枠が潰れていない（開いた枠は必ず閉じる）。
    expect(lines.filter((l) => l.includes('╭')).length).toBe(
      lines.filter((l) => l.includes('╰')).length,
    );
    app.unmount();
  });

  it('filters the palette by the typed prefix', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/ex');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/exit');
    expect(frame).not.toContain('/help');
  });

  it('does not create a session when a command is submitted', async () => {
    const manager = makeManager();
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  // `/help` は全件が読めることが目的なので、開いている間はヘッダ（装飾）を隠して
  // 場所を譲る。24 行の端末でも末尾の `/help` `/exit` まで畳まれないことを固定する。
  it('/help opens the help overlay listing every command', async () => {
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={makeManager()} />, 24, 100);
    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain(messages.ja.command.helpTitle);
    expect(frame).toContain(messages.ja.command.help); // /help description
    expect(frame).toContain(messages.ja.command.exit); // /exit description
    expect(frame).toContain(messages.ja.command.config); // /config description
    // 1 件も畳まれていない（畳まれると「他 N 件」が出て末尾のコマンドが消える）。
    for (const command of COMMANDS) {
      expect(frame).toContain(`/${command.name}`);
    }
    app.unmount();
  });

  it('/exit tears down the manager and exits', async () => {
    const manager = makeManager();
    const dispose = vi.spyOn(manager, 'dispose');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/exit');
    await flush();
    stdin.write('\r');
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
  });

  // スラッシュ無しでも実行されるなら、確定前にパレットで予告する（無言で終了しない）。
  it('previews a bare command in the palette, but not when text follows it', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('exit');
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.command.exit);
    stdin.write(' の挙動を直して'); // 後続テキスト → ただの指示に戻る
    await flush();
    expect(lastFrame() ?? '').not.toContain(messages.ja.command.paletteTitle);
  });

  it('a bare `exit` (no slash) exits too', async () => {
    const manager = makeManager();
    const dispose = vi.spyOn(manager, 'dispose');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('exit');
    await flush();
    stdin.write('\r');
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('`exit` followed by text stays a normal instruction', async () => {
    const manager = makeManager();
    const dispose = vi.spyOn(manager, 'dispose');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('exit の挙動を直して');
    await flush();
    stdin.write('\r');
    await flush();
    expect(dispose).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toHaveLength(1);
  });

  it('/prompt opens the repo-prompt editor and saves the edited instructions', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/prompt');
    await flush();
    stdin.write('\r'); // run the command → opens the editor
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.prompt.title);
    stdin.write('run tests then open a PR');
    await flush();
    stdin.write('\r'); // Enter saves
    await flush();
    expect(manager.getRepoPrompt()).toBe('run tests then open a PR');
    // Editor closed — the title is gone and no session was created.
    expect(lastFrame() ?? '').not.toContain(messages.ja.prompt.title);
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  // 入力欄（INPUT）と同じ操作でリポジトリ指示を持ち出せること。背後の一覧・ヘッダにも
  // 同じ生レポートが届くため、二重に選択・コピーされないこと（= copied が 1 件）も見る。
  it('/prompt エディタのドラッグで選択範囲がコピーされる（背後の一覧は動かない）', async () => {
    const copied: string[] = [];
    const manager = makeManager();
    manager.setRepoPrompt('open a PR');
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={manager} onCopy={(t) => copied.push(t)} />,
      24,
      100,
    );
    stdin.write('/prompt');
    await flush();
    stdin.write('\r'); // エディタを開く（既存のリポジトリ指示が入った状態）
    await flush();

    const lines = stripAnsi(lastFrame()).split('\n');
    const row = lines.findIndex((l) => l.includes('open a PR'));
    expect(row).toBeGreaterThan(0);
    const startCol = (lines[row] ?? '').indexOf('PR');
    stdin.write(`\x1b[<0;${startCol + 1};${row + 1}M`); // press
    await flush();
    stdin.write(`\x1b[<32;${startCol + 3};${row + 1}M`); // drag（motion bit 32）
    await flush();
    stdin.write(`\x1b[<0;${startCol + 3};${row + 1}m`); // release → 1 回だけコピー
    await flush();

    expect(copied).toEqual(['PR']);
    // 指示は書き換わらず、エディタも開いたまま（選択はテキストを消さない）。
    expect(lastFrame()).toContain('open a PR');
    stdin.write('\x1b');
    await flush();
    expect(manager.getRepoPrompt()).toBe('open a PR');
    app.unmount();
  });

  // Regression: `DialogBox` に `flexShrink={0}` が無く、低い端末ではダイアログ自身が
  // 縮んで**中間の行が抜けて**描かれていた（`ccc2` の次が `fff5` になる）。行が抜けた
  // 状態では見えている行と当たり判定が食い違い、押した行とは別の文字がコピーされる。
  it('低い端末でもエディタは縮まず、見えている行をドラッグするとその行がコピーされる', async () => {
    const copied: string[] = [];
    const manager = makeManager();
    manager.setRepoPrompt(['aaa0', 'bbb1', 'ccc2', 'ddd3', 'eee4', 'fff5'].join('\n'));
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={manager} onCopy={(t) => copied.push(t)} />,
      17, // MIN_FULLSCREEN_ROWS は超えるが、ヘッダ + 6 行のダイアログには足りない高さ
      100,
    );
    stdin.write('/prompt');
    await settle(lastFrame);
    stdin.write('\r');
    // 座標をフレームから割り出す前は**描画が止まるまで**待つ（固定 flush では、まだ
    // 描き変わる余地があるうちに押して別の行に当たる。helpers.ts の `settle` の注記）。
    await settle(lastFrame);

    const lines = stripAnsi(lastFrame()).split('\n');
    // 6 行すべてが順番どおり描かれている（縮小で抜けていない）。
    for (const line of ['aaa0', 'bbb1', 'ccc2', 'ddd3', 'eee4', 'fff5']) {
      expect(lines.some((l) => l.includes(line))).toBe(true);
    }
    const row = lines.findIndex((l) => l.includes('ccc2'));
    const col = (lines[row] ?? '').indexOf('ccc2');
    stdin.write(`\x1b[<0;${col + 1};${row + 1}M`);
    await settle(lastFrame);
    stdin.write(`\x1b[<32;${col + 5};${row + 1}M`);
    await settle(lastFrame);
    stdin.write(`\x1b[<0;${col + 5};${row + 1}m`);
    await settle(lastFrame);

    expect(copied).toEqual(['ccc2']);
    app.unmount();
  });

  // モーダルの相互排他: 同じ生レポートは兄弟の useInput にも届くので、一覧側で飲まないと
  // モーダル上のドラッグでヘッダ（cwd）が選択・コピーされてしまう。
  it('/model を開いている間のドラッグは背後のヘッダを選択しない', async () => {
    const copied: string[] = [];
    const cwd = '/Users/hoge/codiva';
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={makeManager()} cwd={cwd} onCopy={(t) => copied.push(t)} />,
      24,
      100,
    );
    stdin.write('/model');
    await flush();
    stdin.write('\r'); // モデル選択を開く
    await flush();

    const lines = stripAnsi(lastFrame()).split('\n');
    const row = lines.findIndex((l) => l.includes(cwd));
    expect(row).toBeGreaterThan(0);
    const startCol = (lines[row] ?? '').indexOf(cwd);
    stdin.write(`\x1b[<0;${startCol + 1};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${startCol + cwd.length + 1};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${startCol + cwd.length + 1};${row + 1}m`);
    await flush();

    expect(copied).toEqual([]);
    app.unmount();
  });

  it('/prompt editor cancels on Esc without changing the instructions', async () => {
    const manager = makeManager();
    manager.setRepoPrompt('keep me');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/prompt');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('\x1b'); // Esc cancels
    await flush();
    expect(manager.getRepoPrompt()).toBe('keep me');
    expect(lastFrame() ?? '').not.toContain(messages.ja.prompt.title);
  });

  it('lists /clear in the command palette', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/clear');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/clear');
    expect(frame).toContain(messages.ja.command.clear); // description shown
  });

  // worktree とブランチまで消す操作になったので、件数を見せて y を取ってから実行する。
  it('/clear asks first (with the count) and clears on y', async () => {
    const manager = makeFinishedManager();
    const clear = vi.spyOn(manager, 'clear');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('finish me');
    await flush();
    stdin.write('\r'); // 1 セッション作成 → 終端状態（中断）になる
    await flush();
    stdin.write('/clear');
    await flush();
    stdin.write('\r');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain(messages.ja.action.clearPrompt(1));
    expect(clear).not.toHaveBeenCalled(); // 確認前は実行しない
    stdin.write('y');
    await flush();
    expect(clear).toHaveBeenCalledOnce();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('/clear does nothing when no session has finished', async () => {
    const manager = makeManager(); // sessions stay in `creating`
    const clear = vi.spyOn(manager, 'clear');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/clear');
    await flush();
    stdin.write('\r');
    await flush();
    expect(clear).not.toHaveBeenCalled();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain(messages.ja.action.clearPrompt(0));
  });

  it('lists /remove in the command palette and asks before removing', async () => {
    const manager = makeManager();
    const remove = vi.spyOn(manager, 'remove');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('build a thing');
    await flush();
    stdin.write('\r'); // create the session /remove will target
    await flush();
    stdin.write('/remove');
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.command.remove);
    stdin.write('\r');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain(messages.ja.action.removePrompt);
    expect(remove).not.toHaveBeenCalled();
    stdin.write('y');
    await flush();
    expect(remove).toHaveBeenCalledOnce();
    // 破棄と違い行も残らない（= 一括立て直しの対象からも外れる）。
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('x on the selected row removes it after the confirmation', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('build a thing');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('\t'); // Tab → list focus（印字キーが操作キーになる）
    await flush();
    stdin.write('x');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain(messages.ja.action.removePrompt);
    stdin.write('n'); // n で取りやめ → 行は残る
    await flush();
    expect(manager.getSnapshot()).toHaveLength(1);
    stdin.write('x');
    await flush();
    stdin.write('y');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  // `/config`: 開く → トグル → 差分が親（合成ルート = 設定ファイル）へ上がる。
  it('/config toggles a setting and reports the patch', async () => {
    const patches: Partial<CodivaConfig>[] = [];
    const { stdin, lastFrame } = render(
      <App manager={makeManager()} onConfigChange={(patch) => patches.push(patch)} />,
    );
    stdin.write('/config');
    await flush();
    stdin.write('\r');
    await flush();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain(messages.ja.config.title);
    // 既定 on の 1 行目（デスクトップ通知）にカーソルがあり、チェックが入っている。
    expect(frame).toContain(messages.ja.config.notifications);
    expect(frame).toContain('[x]');

    stdin.write('\r'); // Enter でその行を反転
    await flush();
    expect(patches).toEqual([{ notifications: false }]);
    // 表示も追従する（親が state を持っているので開いたまま反映される）。
    expect(stripAnsi(lastFrame() ?? '')).toContain('[ ]');

    stdin.write(' '); // Space でも切り替えられる（既定へ戻る = キー削除）
    await flush();
    expect(patches).toEqual([{ notifications: false }, { notifications: undefined }]);
  });

  it('/config closes on Esc and stops owning the keys', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/config');
    await flush();
    stdin.write('\r');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).toContain(messages.ja.config.title);
    stdin.write('\x1b');
    await flush();
    expect(stripAnsi(lastFrame() ?? '')).not.toContain(messages.ja.config.title);
    // 閉じたあとの入力は普通の指示として通る（キーを飲んだままにならない）。
    stdin.write('build a thing');
    await flush();
    stdin.write('\r');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(1);
  });

  // モーダルの相互排他（`/model` と同じ回帰テスト）。ガードは**マウスとキーの 2 箇所**に
  // 要るので、片方の付け忘れをここで検出する。
  it('/config を開いている間のドラッグは背後のヘッダを選択しない', async () => {
    const copied: string[] = [];
    const cwd = '/Users/hoge/codiva';
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={makeManager()} cwd={cwd} onCopy={(t) => copied.push(t)} />,
      24,
      100,
    );
    stdin.write('/config');
    await flush();
    stdin.write('\r');
    await flush();

    const lines = stripAnsi(lastFrame()).split('\n');
    const row = lines.findIndex((l) => l.includes(cwd));
    expect(row).toBeGreaterThan(0);
    const startCol = (lines[row] ?? '').indexOf(cwd);
    stdin.write(`\x1b[<0;${startCol + 1};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${startCol + cwd.length + 1};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${startCol + cwd.length + 1};${row + 1}m`);
    await flush();

    expect(copied).toEqual([]);
    app.unmount();
  });

  it('reports an unknown command as an error', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/frobnicate');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.command.unknown('frobnicate'));
    expect(manager.getSnapshot()).toHaveLength(0);
  });
});
