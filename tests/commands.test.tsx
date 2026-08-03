import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { messages } from '@/core/i18n';
import { flush, makeManager, renderFullscreen, stripAnsi } from './helpers';

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
    expect(frame).toContain('/help');
    expect(frame).toContain('/exit');
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

  it('/help opens the help overlay listing every command', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(messages.ja.command.helpTitle);
    expect(frame).toContain(messages.ja.command.help); // /help description
    expect(frame).toContain(messages.ja.command.exit); // /exit description
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
    await flush();
    stdin.write('\r');
    await flush();

    const lines = stripAnsi(lastFrame()).split('\n');
    // 6 行すべてが順番どおり描かれている（縮小で抜けていない）。
    for (const line of ['aaa0', 'bbb1', 'ccc2', 'ddd3', 'eee4', 'fff5']) {
      expect(lines.some((l) => l.includes(line))).toBe(true);
    }
    const row = lines.findIndex((l) => l.includes('ccc2'));
    const col = (lines[row] ?? '').indexOf('ccc2');
    stdin.write(`\x1b[<0;${col + 1};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${col + 5};${row + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${col + 5};${row + 1}m`);
    await flush();

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

  it('/clear clears the session list and creates no session', async () => {
    const manager = makeManager();
    const clear = vi.spyOn(manager, 'clear');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/clear');
    await flush();
    stdin.write('\r');
    await flush();
    expect(clear).toHaveBeenCalledOnce();
    expect(manager.getSnapshot()).toHaveLength(0);
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
