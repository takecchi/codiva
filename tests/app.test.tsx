import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { AsyncQueue } from '@/core/async-queue';
import { messages } from '@/core/i18n';
import { PR_POLL_STABLE_MS } from '@/core/pr-refresh';
import type { QueryFn } from '@/core/session';
import { SessionManager } from '@/core/session-manager';
import type { PrLookup, WorktreeService } from '@/core/session-ports';
import { reduce } from '@/core/status-reducer';
import type { PrLookupResult, SessionState } from '@/core/types';
import { glyph } from '@/ui/theme';
import {
  flush,
  makeManager,
  noopSession,
  renderFullscreen,
  stripAnsi,
  fakeWorktrees as worktrees,
} from './helpers';

// Feature/integration tests: drive the whole App (list ⇄ detail) through a real
// SessionManager. Unit tests for individual modules live next to them as *.spec.ts.
// Shared fakes (worktrees, sessions, fullscreen renderer) live in ./helpers.

/**
 * Stand-in for the model catalog codiva fetches from Claude Code at startup
 * (`fetchModelCatalog`). Shaped like real `supportedModels()` output so the
 * picker is driven by injected data rather than a hardcoded list.
 */
const MODEL_CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Default (recommended)',
  },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
];

describe('App fullscreen layout', () => {
  it('renders a frame exactly as tall as the terminal, footer pinned to the bottom', () => {
    const { app, lastFrame } = renderFullscreen(<App manager={makeManager()} />, 20);
    const lines = lastFrame().split('\n');
    // フルスクリーン化していなければコンテンツ高さ（〜13行）しか出ない。
    expect(lines).toHaveLength(20);
    expect(lastFrame()).toContain('Codiva');
    // 入力欄+フッタが flexGrow スペーサで画面最下段（下パディングの上）に来る。
    const lastContent = lines.filter((l) => l.trim() !== '').at(-1);
    expect(lastContent).toContain('自動モード');
    app.unmount();
  });

  it('scrolls the session list internally, keeping the frame height and footer fixed', async () => {
    const manager = makeManager();
    // 幅は広め（経過時間表示で行が折り返さないように）。
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 120);
    // 一覧領域（〜6行）に収まりきらない数のセッションを作る。
    for (let i = 0; i < 12; i++) {
      stdin.write(`task-${String(i).padStart(2, '0')}`);
      await flush();
      stdin.write('\r');
      await flush();
    }

    const initial = lastFrame();
    // フレーム高さは端末ぴったり、フッタは最下段に固定されたまま。
    expect(initial.split('\n')).toHaveLength(20);
    expect(
      initial
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1),
    ).toContain('自動モード');
    // 先頭は見え、末尾は隠れ、下に「さらに N 件」インジケータが出る。
    expect(initial).toContain('task-00');
    expect(initial).not.toContain('task-11');
    expect(initial).toContain('↓');

    // 一覧へフォーカスし、末尾まで選択を下げるとウィンドウがスクロールする。
    stdin.write('\t');
    await flush();
    for (let i = 0; i < 11; i++) {
      stdin.write('\x1b[B'); // ↓
      await flush();
    }

    const scrolled = lastFrame();
    expect(scrolled.split('\n')).toHaveLength(20);
    // 入力欄+フッタは最下部に残る（list フォーカスの長いヒントが折り返しても
    // クリップされない）。最下段はセッション行ではなくフッタ＝一覧が押し下げていない。
    expect(scrolled).toContain(messages.ja.list.promptPlaceholder);
    expect(
      scrolled
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1),
    ).not.toContain('task-');
    expect(scrolled).toContain('task-11'); // 末尾が見えるようになった
    expect(scrolled).not.toContain('task-00'); // 先頭は隠れた
    expect(scrolled).toContain('↑'); // 上に隠れた件数のインジケータ
    app.unmount();
  }, 20000);

  it('mouse-wheel reports scroll the session list (down reveals newer, up the top)', async () => {
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 120);
    // 一覧領域に収まりきらない数のセッションを用意する。マウント後に作るので
    // 選択は先頭（task-00）に留まり、末尾（task-11）は下へ隠れている。
    for (let i = 0; i < 12; i++) {
      stdin.write(`task-${String(i).padStart(2, '0')}`);
      await flush();
      stdin.write('\r');
      await flush();
    }

    const initial = lastFrame();
    expect(initial).toContain('task-00'); // 先頭が見えている
    expect(initial).not.toContain('task-11'); // 末尾は下へ隠れている
    expect(initial).toContain('↓'); // 下に隠れた件数のインジケータ

    // ホイール下（button 65）を何度も送ると選択が下へ動き、窓が下へスクロールして
    // 末尾が見えるようになる。生テキスト（`65`）としてコンポーザへ漏れてはいけない。
    for (let i = 0; i < 12; i++) {
      stdin.write('\x1b[<65;10;5M');
      await flush();
    }
    const down = lastFrame();
    expect(down.split('\n')).toHaveLength(20); // フレーム高さは固定のまま
    expect(down).toContain('task-11'); // 末尾が見えるようになった
    expect(down).not.toContain('task-00'); // 先頭は上へ隠れた
    expect(down).toContain('↑'); // 上に隠れた件数のインジケータ
    expect(down).toContain(messages.ja.list.promptPlaceholder); // コンポーザは空のまま
    // エスケープ列（SGR レポート本体 `6[45];col;row`）がテキストとして漏れていない。
    // ボタン番号 `64|65` だけを見ると動作時間列の数字に誤マッチするため本体パターンで判定する。
    expect(down).not.toMatch(/6[45];\d+;\d+/);

    // ホイール上（button 64）で選択が上へ戻り、再び先頭が見える。
    for (let i = 0; i < 12; i++) {
      stdin.write('\x1b[<64;10;5M');
      await flush();
    }
    const up = lastFrame();
    expect(up).toContain('task-00');
    expect(up).not.toContain('task-11');
    app.unmount();
  }, 30000);

  it('opens with the newest (bottom) session selected and scrolled into view', async () => {
    const manager = makeManager();
    // 一覧領域に収まりきらない数のセッションを起動前に用意する（永続化からの復元相当）。
    for (let i = 0; i < 12; i++) {
      manager.create(`task-${String(i).padStart(2, '0')}`);
    }
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 120);
    const frame = lastFrame();
    // 開いた直後から末尾（最新）が見え、先頭は上へスクロールされて隠れている。
    expect(frame).toContain('task-11');
    expect(frame).not.toContain('task-00');
    expect(frame).toContain('↑'); // 上に隠れた件数のインジケータ
    // 選択カーソル（❯）は最新の task-11 の行に乗っている。
    const selectedLine = frame.split('\n').find((l) => l.includes('task-11')) ?? '';
    expect(selectedLine).toContain('❯');
    app.unmount();
  });

  it('keeps sessions in creation order even when one is archived (does not sink)', async () => {
    // archived になったセッションでも作成順（上が古い・下が新しい）の位置を保つ。
    const manager = new SessionManager({
      worktrees,
      queryFn: (() => {
        throw new Error('unused');
      }) as never,
      now: () => 0,
      createSession: ({ input }) => {
        const session = noopSession(input);
        // 中央の task-1 を archived 状態にして、末尾へ沈まないことを検証する。
        if (input.title === 'task-1') {
          session.state = { ...session.state, status: 'archived' };
        }
        return session;
      },
    });
    for (let i = 0; i < 3; i++) {
      manager.create(`task-${i}`);
    }
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 120);
    const lines = lastFrame().split('\n');
    const rowOf = (title: string) => lines.findIndex((l) => l.includes(title));
    // archived の task-1 は依然として task-0 と task-2 の間にある。
    expect(rowOf('task-0')).toBeGreaterThanOrEqual(0);
    expect(rowOf('task-0')).toBeLessThan(rowOf('task-1'));
    expect(rowOf('task-1')).toBeLessThan(rowOf('task-2'));
    app.unmount();
  });

  it('falls back to inline rendering on very short terminals (footer stays visible)', () => {
    const { app, lastFrame } = renderFullscreen(<App manager={makeManager()} />, 8);
    // height 固定だと 8 行にクリップされ入力欄・フッタが消える。フォールバックでは
    // コンテンツの高さぶん（8行超）描画され、フッタまで見える。
    expect(lastFrame().split('\n').length).toBeGreaterThan(8);
    expect(lastFrame()).toContain('自動モード');
    app.unmount();
  });

  it('mouse click selects a session row; click in the composer moves the caret', async () => {
    const manager = makeManager();
    // 幅は広めに取る（テストの経過時間表示が巨大で 80 桁だと行が折り返すため）。
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 24, 120);
    stdin.write('first task');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('second task');
    await flush();
    stdin.write('\r');
    await flush();

    // クリック位置はフレームから実際の行を探して算出（レイアウト変更に追従）。
    const rowIndex = lastFrame()
      .split('\n')
      .findIndex((l) => l.includes('second task'));
    expect(rowIndex).toBeGreaterThan(0);
    stdin.write(`\x1b[<0;5;${rowIndex + 1}M`); // SGR press (1-based row)
    await flush();
    // 一覧フォーカスのフッタヒントに切り替わる。
    expect(lastFrame()).toContain('詳細を開く');

    // 印字キーで自動的にコンポーザへ戻り、そのまま入力できる。
    stdin.write('hello world');
    await flush();
    const frame = lastFrame();
    const lineIndex = frame.split('\n').findIndex((l) => l.includes('hello world'));
    const line = frame.split('\n')[lineIndex] ?? '';
    const col = line.indexOf('world'); // ASCII のみなのでセル位置 = 文字位置
    stdin.write(`\x1b[<0;${col + 1};${lineIndex + 1}M`); // click before 'world'
    await flush();
    stdin.write('X');
    await flush();
    expect(lastFrame()).toContain('hello Xworld');
    app.unmount();
  });

  it('dragging over the composer selects text and copies it on release (OSC 52)', async () => {
    const copied: string[] = [];
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={manager} onCopy={(t) => copied.push(t)} />,
      20,
      120,
    );
    stdin.write('hello world');
    await flush();

    const frame = lastFrame();
    const lineIndex = frame.split('\n').findIndex((l) => l.includes('hello world'));
    const line = frame.split('\n')[lineIndex] ?? '';
    const startCol = line.indexOf('world'); // frame col of 'w' (includes `❯ ` prefix)
    const endCol = startCol + 'world'.length; // just past 'd'
    // Press on 'w', drag (motion bit 32) to the end, then release → copy once.
    stdin.write(`\x1b[<0;${startCol + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${endCol + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${endCol + 1};${lineIndex + 1}m`);
    await flush();

    expect(copied).toEqual(['world']);
    // The dragged text is still typed in the composer (selection doesn't delete).
    expect(lastFrame()).toContain('hello world');
    app.unmount();
  });

  it('ヘッダの cwd をドラッグするとパスがコピーされる（選択行もフォーカスも動かない）', async () => {
    const copied: string[] = [];
    const cwd = '/Users/hoge/codiva';
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={manager} cwd={cwd} onCopy={(t) => copied.push(t)} />,
      20,
      120,
    );
    // マスコットの右のテキスト欄は縦中央寄せなので、位置はフレームから実測する。
    // 装飾（SGR）は落としてから列を数える — 色が有効な環境だとエスケープ列のぶん
    // インデックスがズレ、送るマウス座標が別の場所になってしまう。
    await flush();
    const rowsOf = () => stripAnsi(lastFrame()).split('\n');
    const lineIndex = rowsOf().findIndex((l) => l.includes(cwd));
    expect(lineIndex).toBeGreaterThan(0);
    const startCol = (rowsOf()[lineIndex] ?? '').indexOf(cwd);
    const endCol = startCol + cwd.length; // just past the last character

    stdin.write(`\x1b[<0;${startCol + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${endCol + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${endCol + 1};${lineIndex + 1}m`);
    await flush();

    expect(copied).toEqual([cwd]);
    // ヘッダのドラッグはフォーカスを奪わない: そのまま入力するとコンポーザに入る
    // （一覧フォーカスへ移っていれば印字キーは選択操作に食われる）。
    stdin.write('after drag');
    await flush();
    expect(lastFrame()).toContain('after drag');
    app.unmount();
  });

  it('ヘッダのテキスト以外（マスコット・行末より右）のドラッグは選択にならない', async () => {
    const copied: string[] = [];
    const cwd = '/Users/hoge/codiva';
    const { app, stdin, lastFrame } = renderFullscreen(
      <App manager={makeManager()} cwd={cwd} onCopy={(t) => copied.push(t)} />,
      20,
      120,
    );
    await flush();
    const lineIndex = stripAnsi(lastFrame())
      .split('\n')
      .findIndex((l) => l.includes(cwd));
    // 左端（マスコット側）は選択対象のテキストではないので何も起きない。
    stdin.write(`\x1b[<0;2;${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;10;${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;10;${lineIndex + 1}m`);
    await flush();
    expect(copied).toEqual([]);

    // 行末より右の余白も当たりにしない（何も無い場所のクリックを飲まない）。
    const rightOfPath = stripAnsi(lastFrame()).split('\n')[lineIndex]?.indexOf(cwd) ?? 0;
    const farRight = rightOfPath + cwd.length + 6;
    stdin.write(`\x1b[<0;${farRight + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<32;${rightOfPath + 1};${lineIndex + 1}M`);
    await flush();
    stdin.write(`\x1b[<0;${rightOfPath + 1};${lineIndex + 1}m`);
    await flush();
    expect(copied).toEqual([]);
    app.unmount();
  });

  it('a burst of arrow keys in one chunk moves the caret cumulatively', async () => {
    // 端末はエスケープ列をまとめて1チャンクで届けることがある。stale closure だと
    // ←×5 が1回分しか効かない（バッファ更新は ref 経由で逐次適用する）。
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20);
    stdin.write('hello world');
    await flush();
    stdin.write('\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D'); // ←×5 in a single chunk
    await flush();
    stdin.write('X');
    await flush();
    expect(lastFrame()).toContain('hello Xworld');
    app.unmount();
  });

  it('↑↓ で送信済みの指示を入力欄に呼び戻す（履歴・書きかけの復帰込み）', async () => {
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 24, 120);
    /** フレーム内の出現回数（一覧の行 + 入力欄の 2 箇所を数え分けるため）。 */
    const count = (text: string) => stripAnsi(lastFrame()).split(text).length - 1;

    for (const text of ['first task', 'second task']) {
      stdin.write(text);
      await flush();
      stdin.write('\r');
      await flush();
    }
    // 送信後の入力欄は空（一覧の行にだけ現れる）。
    expect(count('second task')).toBe(1);

    // 書きかけを残した状態で ↑ → 最新の履歴が入る（書きかけは退避される）。
    stdin.write('draft');
    await flush();
    stdin.write('\x1b[A');
    await flush();
    expect(count('second task')).toBe(2);
    expect(count('draft')).toBe(0);

    // さらに ↑ で 1 つ古い履歴へ。
    stdin.write('\x1b[A');
    await flush();
    expect(count('first task')).toBe(2);

    // ↓ で新しい方へ戻り、最新を越えると書きかけが復帰する。
    stdin.write('\x1b[B');
    await flush();
    expect(count('second task')).toBe(2);
    stdin.write('\x1b[B');
    await flush();
    expect(count('draft')).toBe(1);
    app.unmount();
  });

  it('複数行を編集中の ↑ は履歴ではなくキャレット移動（行の途中で書きかけが消えない）', async () => {
    const manager = makeManager();
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 24, 120);
    // 単語区切りのある指示にする（slug は 'old-task' なので、一覧のブランチ列が
    // 'old task' として二重にヒットしない）。
    stdin.write('old task');
    await flush();
    stdin.write('\r');
    await flush();

    // Shift+Enter（CSI-u）で 2 行の書きかけを作り、下の行から ↑ を押す。
    stdin.write('line1');
    await flush();
    stdin.write('\x1b[27;2;13~');
    await flush();
    stdin.write('line2');
    await flush();
    stdin.write('\x1b[A');
    await flush();
    // 1 行目へキャレットが動くだけ（履歴は呼ばれない = 書きかけが残る）。
    expect(lastFrame()).toContain('line1');
    expect(lastFrame()).toContain('line2');
    // 最上段に着いたので次の ↑ で履歴が入る。
    stdin.write('\x1b[A');
    await flush();
    expect(stripAnsi(lastFrame()).split('old task').length - 1).toBe(2);
    app.unmount();
  });

  it('enables includePartialMessages so streaming state stays available', async () => {
    const out = new AsyncQueue<SDKMessage>();
    let captured: Options | undefined;
    const queryFn = ((params: { options: Options }) => {
      captured = params.options;
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });

    const { app, stdin } = renderFullscreen(<App manager={manager} />, 20);
    stdin.write('stream it');
    await flush();
    stdin.write('\r');
    await flush();
    expect((captured as { includePartialMessages?: boolean }).includePartialMessages).toBe(true);
    app.unmount();
  });
});

describe('App (list view)', () => {
  it('renders the banner and empty-state hint', () => {
    const { lastFrame } = render(<App manager={makeManager()} />);
    expect(lastFrame()).toContain('Codiva');
    expect(lastFrame()).toContain('最初のセッション');
  });

  // Ctrl+U = 書きかけの一括破棄。macOS の Cmd+Delete は端末がアプリへ送らないため、
  // 全端末で確実に届く ctrl chord にしてある（フォーカスは入力欄のまま）。
  it('Ctrl+U clears the composer without creating a session', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('ログイン機能を実装してください');
    await flush();
    expect(lastFrame()).toContain('ログイン機能を実装してください');

    stdin.write('\x15'); // Ctrl+U
    await flush();
    expect(lastFrame()).not.toContain('ログイン機能を実装してください');
    expect(lastFrame()).toContain(messages.ja.list.promptPlaceholder);
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('shows the polled plan + usage in the header (not in the footer)', async () => {
    // The wiring index.tsx sets up: usage poller → manager.applyUsage → banner.
    const manager = makeManager();
    manager.applyUsage({
      account: { plan: 'Claude Team', organization: 'Example Inc' },
      usage: {
        limitsAvailable: true,
        windows: [{ type: 'five_hour', utilization: 50, resetsAt: Date.now() + 45 * 60_000 }],
      },
    });
    manager.create('task');
    await flush();

    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 24, 120);
    // 一覧: プラン行 + 使用状況（ゲージ + 使用率）はヘッダ（バナー）の担当。
    expect(lastFrame()).toContain('プラン: Claude Team (Example Inc)');
    expect(lastFrame()).toContain('使用状況');
    expect(lastFrame()).toContain('50%');
    // フッタはモード行 + ヒントだけ（使用状況は詰め込まない）。
    const footer = (lastFrame() ?? '').split('\n').find((l) => l.includes('自動モード')) ?? '';
    expect(footer).not.toContain('█');
    expect(footer).not.toContain('50%');

    // 詳細（バナーが無い画面）ではプラン・使用状況を出さない。
    stdin.write('\t');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).not.toContain('Claude Team');
    expect(lastFrame()).not.toContain('50%');
    app.unmount();
  });

  // index.tsx → App → SessionList → Banner の配線。どこかで prop を落とすと
  // 「一度も警告が出ない」= 気付けない壊れ方になるため、通しで検証する。
  it('学習データ利用が ON と判定されたらバナーに注意行を出す', async () => {
    const { lastFrame } = render(
      <App manager={makeManager()} trainingOptIn={Promise.resolve('on')} />,
    );
    await flush();
    expect(lastFrame()).toContain('学習データ利用が ON');
    expect(lastFrame()).toContain('https://claude.ai/settings/data-privacy-controls');
  });

  it('学習データ利用が OFF なら何も出さない', async () => {
    const { lastFrame } = render(
      <App manager={makeManager()} trainingOptIn={Promise.resolve('off')} />,
    );
    await flush();
    expect(lastFrame()).not.toContain('学習データ利用');
  });

  it('renders in English when the en catalog is injected', () => {
    // The path index.tsx uses: resolved catalog → App messages prop → provider → components.
    const { lastFrame } = render(<App manager={makeManager()} messages={messages.en} />);
    expect(lastFrame()).toContain('Type an instruction');
    expect(lastFrame()).toContain('Tab: list');
  });

  it('creates a session when the user types and presses Enter', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('build login');
    await flush(); // let the buffer state settle before Enter
    stdin.write('\r'); // Enter
    await flush();
    expect(manager.getSnapshot()).toHaveLength(1);
    expect(lastFrame()).toContain('build login');
    expect(lastFrame()).toContain('1 セッション');
  });

  it('a trailing backslash + Enter inserts a newline instead of submitting', async () => {
    const manager = makeManager();
    const { stdin } = render(<App manager={manager} />);
    stdin.write('line one\\'); // ends with a backslash
    await flush();
    stdin.write('\r'); // Enter → newline (continuation), not submit
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0); // nothing created yet

    stdin.write('line two');
    await flush();
    stdin.write('\r'); // no trailing backslash → submit the two-line prompt
    await flush();
    expect(manager.getSnapshot()).toHaveLength(1);
    expect(manager.getSnapshot()[0]?.prompt).toBe('line one\nline two');
  });

  it('Shift+Enter (modifyOtherKeys escape) inserts a newline instead of submitting', async () => {
    const manager = makeManager();
    const { stdin } = render(<App manager={manager} />);
    stdin.write('line one');
    await flush();
    // Ghostty/xterm send Shift+Enter as `ESC [27;2;13~` — it must break the line,
    // not get inserted verbatim as `[27;2;13~`.
    stdin.write('\x1b[27;2;13~');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0); // newline, not submit

    stdin.write('line two');
    await flush();
    stdin.write('\r'); // plain Enter → submit
    await flush();
    expect(manager.getSnapshot()).toHaveLength(1);
    expect(manager.getSnapshot()[0]?.prompt).toBe('line one\nline two');
  });
});

function asMsg(m: unknown): SDKMessage {
  return m as SDKMessage;
}

describe('App end-to-end (real Session, driven query)', () => {
  it('shows live task progress in the list and reaches 完了', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('implement feature');
    await flush();
    stdin.write('\r');
    await flush(); // provision worktree + start session

    out.push(
      asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-x', model: 'claude-opus-4-8' }),
    );
    out.push(
      asMsg({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: '1', name: 'TaskCreate', input: { subject: 'step one' } },
            { type: 'tool_use', id: '2', name: 'TaskCreate', input: { subject: 'step two' } },
          ],
        },
      }),
    );
    await flush();
    expect(lastFrame()).toContain('Step 0/2');
    // the session row shows the model it actually resolved to (from system/init)
    expect(lastFrame()).toContain('Opus 4.8');

    out.push(
      asMsg({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: '3',
              name: 'TaskUpdate',
              input: { taskId: '1', status: 'completed' },
            },
          ],
        },
      }),
    );
    await flush();
    expect(lastFrame()).toContain('Step 1/2');

    out.push(asMsg({ type: 'result', subtype: 'success', result: 'all done' }));
    await flush();
    expect(lastFrame()).toContain('完了');
  });

  it('shift+tab switches to confirm mode so tools escalate to 許可待ち', async () => {
    const out = new AsyncQueue<SDKMessage>();
    let captured: Options | undefined;
    const queryFn = ((params: { options: Options }) => {
      captured = params.options;
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });
    const { stdin, lastFrame } = render(<App manager={manager} />);

    stdin.write('[Z'); // shift+tab → confirm mode
    await flush();
    expect(manager.getMode()).toBe('confirm');

    stdin.write('run a tool');
    await flush();
    stdin.write('\r');
    await flush(); // provision worktree + start session (captures options)
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-c' }));
    await flush();

    // Simulate the SDK asking to run a tool: in confirm mode the policy escalates.
    // Session's canUseTool ignores the 3rd context arg, so a minimal cast suffices.
    const ctx = { signal: new AbortController().signal } as unknown as Parameters<
      NonNullable<Options['canUseTool']>
    >[2];
    const decision = captured?.canUseTool?.('Bash', { command: 'ls' }, ctx);
    await flush();
    expect(manager.getSnapshot()[0]?.status).toBe('awaiting_permission');
    expect(lastFrame()).toContain('許可待ち');
    void decision;
  });

  it('merges a completed session from the list (Tab → m → y) and archives it', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const merge = vi.fn(async () => {});
    const manager = new SessionManager({
      worktrees: { ...worktrees, merge },
      queryFn,
      now: () => 0,
    });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('do it');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-y' }));
    out.push(asMsg({ type: 'result', subtype: 'success', result: 'done' }));
    await flush();

    stdin.write('\t'); // Tab → focus the session list
    await flush();
    stdin.write('m'); // choose merge → confirm
    await flush();
    expect(lastFrame()).toContain('マージします');
    stdin.write('y'); // confirm
    await flush();
    expect(merge).toHaveBeenCalled();
    expect(manager.get('1')?.status).toBe('archived');
  });

  it('shows the accumulated cost in the banner after a result carries total_cost_usd', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('spend some money');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-cost' }));
    out.push(asMsg({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.0123 }));
    await flush();

    expect(lastFrame()).toContain('合計 $0.0123');
  });

  it('shows ログイン必要 (not 完了) when the login expired, and guides the user to log in', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('do it');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-auth' }));
    // How the CLI actually reports an aged-out login: a synthesized assistant
    // message flagged `authentication_failed`, then a `result` whose subtype is
    // still 'success' with `is_error` set. Reading the subtype alone showed the
    // whole thing as a green 完了.
    const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    out.push(
      asMsg({
        type: 'assistant',
        error: 'authentication_failed',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }),
    );
    out.push(
      asMsg({
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: text,
      }),
    );
    await flush();

    expect(manager.get('1')?.status).toBe('needs_login');
    expect(lastFrame()).toContain('ログイン必要');
    expect(lastFrame()).not.toContain('完了');

    // 一覧で選択すると、ログインし直して r で再開する手順がフッタに出る。
    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('claude にログイン');
    expect(lastFrame()).toContain('Ctrl+R: 再開');

    // 詳細ビューでも手順を出す（操作パネルを開いていなくても見える）。
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('/login');
  });

  it('shows 中断 (not 完了) when the response stream was cut mid-answer', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;

    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('do it');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-cut' }));
    // 途中まで答えてから接続が切れたときの実際の並び: 部分応答 → `server_error` を
    // 立てた合成 assistant メッセージ → subtype が success のままの is_error 付き
    // result。subtype だけ見ると成功なので、尻切れの回答が緑の 完了 になっていた。
    out.push(
      asMsg({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'まず調査すると' }] },
      }),
    );
    const text = 'API Error: Connection closed mid-response. The response above may be incomplete.';
    out.push(
      asMsg({
        type: 'assistant',
        error: 'server_error',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      }),
    );
    out.push(
      asMsg({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: null,
        terminal_reason: 'api_error',
        result: text,
      }),
    );
    await flush();

    expect(manager.get('1')?.status).toBe('interrupted');
    expect(lastFrame()).toContain('中断');
    expect(lastFrame()).not.toContain('完了');

    // 一覧で選択すると再開操作が出る（同じ SDK 会話を resume できる）。
    stdin.write('\t');
    await flush();
    expect(lastFrame()).toContain('Ctrl+R: 再開');
  });
});

describe('App detail view (in-app connection)', () => {
  function drivenManager(extra?: Partial<WorktreeService>) {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const manager = new SessionManager({
      worktrees: { ...worktrees, ...extra },
      queryFn,
      now: () => 0,
    });
    return { manager, out };
  }

  it('Enter opens the in-app detail view and Esc returns to the list', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('open me');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-d' }));
    await flush();

    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // Enter → open detail in-app (no external CLI)
    await flush();
    // Detail chrome: the follow-up composer placeholder is shown, and the list
    // composer placeholder is gone (no status header — content + footer only).
    expect(lastFrame()).toContain('追加の指示を入力');
    expect(lastFrame()).not.toContain('実装してほしいこと');

    stdin.write('\x1b'); // Esc → back to the list
    await flush();
    expect(lastFrame()).toContain('実装してほしいこと'); // list composer placeholder
  });

  it('Ctrl+U clears the follow-up composer in the detail view', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('open me');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-clear' }));
    await flush();
    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    stdin.write('やっぱりこの指示はやめる');
    await flush();
    expect(lastFrame()).toContain('やっぱりこの指示はやめる');
    stdin.write('\x15'); // Ctrl+U
    await flush();
    expect(lastFrame()).not.toContain('やっぱりこの指示はやめる');
    expect(lastFrame()).toContain('追加の指示を入力'); // placeholder is back
  });

  // 詳細ビューの `/exit` はアプリ終了ではなく「セッションを閉じて一覧へ戻る」
  // （終了は一覧ビューの `/exit` = commands.test.tsx でカバー）。
  it('/exit in the detail view returns to the list without quitting the app', async () => {
    const { manager, out } = drivenManager();
    const dispose = vi.spyOn(manager, 'dispose');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('close me');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-exit' }));
    await flush();

    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open detail
    await flush();
    expect(lastFrame()).toContain('追加の指示を入力');

    stdin.write('/exit');
    await flush();
    // パレットの説明はビュー固有（「終了」ではなく「一覧へ戻る」）。
    expect(lastFrame()).toContain(messages.ja.command.exitDetail);
    expect(lastFrame()).not.toContain(messages.ja.command.exit);

    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('実装してほしいこと'); // list composer placeholder
    expect(dispose).not.toHaveBeenCalled(); // アプリは終了していない
  });

  // スラッシュ無しのコマンド名はそのビューが実装しているものだけコマンド扱い。
  // 詳細ビューの `exit` は一覧へ戻り、`clear`（詳細では未実装）は追加指示として送る。
  it('a bare `exit` in the detail view returns to the list, a bare `clear` is sent as an instruction', async () => {
    const { manager, out } = drivenManager();
    const send = vi.spyOn(manager, 'send');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('close me');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-bare' }));
    await flush();

    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    stdin.write('clear'); // 詳細に clear ハンドラは無い → 通常の追加指示
    await flush();
    stdin.write('\r');
    await flush();
    expect(send).toHaveBeenCalledWith(expect.any(String), 'clear');
    expect(lastFrame()).toContain('追加の指示を入力'); // 詳細のまま

    stdin.write('exit'); // 詳細の exit = 一覧へ戻る
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('実装してほしいこと'); // list composer placeholder
  });

  it('restores list selection and focus after returning from the detail view', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    for (const t of ['alpha', 'beta', 'gamma']) {
      stdin.write(t);
      await flush();
      stdin.write('\r');
      await flush();
    }
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-r' }));
    await flush();

    stdin.write('\t'); // focus the list (selection starts at the top)
    await flush();
    stdin.write('\x1b[B'); // ↓ → select the middle session (beta)
    await flush();
    const caretRow = (label: string) =>
      (lastFrame() ?? '').split('\n').find((l) => l.includes(label)) ?? '';
    expect(caretRow('beta')).toContain('❯'); // caret sits on beta

    stdin.write('\r'); // open detail for beta
    await flush();
    expect(lastFrame()).toContain('追加の指示を入力'); // in the detail view

    stdin.write('\x1b'); // Esc → back to the list
    await flush();
    // Focus is restored to the list (list-focus footer hint) and the caret is back
    // on beta — the previously viewed row, not the default composer/top.
    expect(lastFrame()).toContain('詳細を開く');
    expect(caretRow('beta')).toContain('❯');
    expect(caretRow('alpha')).not.toContain('❯');
  });

  /**
   * Open the detail view of a session whose log holds `count` numbered lines
   * (`log-00`, `log-01`, …), rendered at a fixed terminal size. `textFor` lets a
   * test emit multi-line Markdown per entry instead of a single line.
   */
  async function detailWithLog(
    count: number,
    rows = 24,
    columns = 80,
    textFor: (i: number) => string = (i) => `log-${String(i).padStart(2, '0')}`,
  ) {
    const { manager, out } = drivenManager();
    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, rows, columns);
    stdin.write('start');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-scroll' }));
    for (let i = 0; i < count; i++) {
      out.push(
        asMsg({
          type: 'assistant',
          message: { content: [{ type: 'text', text: textFor(i) }] },
        }),
      );
    }
    await flush();
    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open the detail view
    await flush();
    /** Log line numbers currently visible, in render order. */
    const visible = () => [...lastFrame().matchAll(/log-(\d+)/g)].map((match) => Number(match[1]));
    return { app, stdin, lastFrame, visible };
  }

  /**
   * The visible log rows must be one unbroken ascending run: Ink/Yoga *shrinks*
   * overflowing children instead of clipping them, so an oversized window drops
   * rows out of the middle of the log rather than scrolling it.
   */
  function expectUnbrokenRun(rowNumbers: readonly number[]): void {
    const [first = -1] = rowNumbers;
    expect(rowNumbers.length).toBeGreaterThan(0);
    expect(rowNumbers).toEqual(rowNumbers.map((_, i) => first + i));
  }

  // Regression (詳細画面のログが上部にスクロールできない): the window was sized from
  // the whole terminal rather than the log viewport, so every frame overflowed and
  // rows silently vanished from the middle of the log; and the anchor could fall
  // below one viewport, leaving the top of the log pinned to the bottom of an
  // otherwise blank screen.
  it('scrolls the detail log up to the very first line, dropping no rows', async () => {
    const { app, stdin, visible } = await detailWithLog(40);

    // Tail-follow: the newest line is on screen, the oldest is not.
    const tail = visible();
    expect(tail.at(-1)).toBe(39);
    expect(tail).not.toContain(0);
    expectUnbrokenRun(tail);

    // PgUp until the top: the first line becomes visible and the page stays full.
    for (let i = 0; i < 10; i++) {
      stdin.write('\x1b[5~');
      await flush();
    }
    const top = visible();
    expect(top).toContain(0);
    expectUnbrokenRun(top);
    // A full page of the oldest lines, not a couple of rows on a blank screen.
    expect(top.length).toBeGreaterThan(10);

    // PgDn returns to the tail.
    for (let i = 0; i < 10; i++) {
      stdin.write('\x1b[6~');
      await flush();
    }
    expect(visible().at(-1)).toBe(39);
    app.unmount();
  }, 30000);

  /**
   * Regression（詳細ログの上端に「表示できるのに空いている」隙間ができる）:
   * Ink の `measureText('')` は **高さ 0** を返すので、空文字の `<Text>` は行として
   * 場所を取らない。ところがスクロール計算（`core/scroll.ts`）は Markdown の段落間の
   * 空行も 1 物理行として数えるため、可視域に含まれる空行のぶんだけ実際の描画が短く
   * なり、末尾寄せ（`justifyContent="flex-end"`）のビューポート上端にその行数ぶんの
   * 空白が残っていた（同時に段落の区切りも消えて行が詰まって見えていた）。
   */
  it('keeps blank log rows one row tall so no gap opens above the log', async () => {
    const { app, lastFrame } = await detailWithLog(
      12,
      24,
      80,
      // 段落 2 つ = 「本文 / 空行 / 本文」の 3 物理行になる Markdown。
      (i) => `para-${String(i).padStart(2, '0')}-a\n\npara-${String(i).padStart(2, '0')}-b`,
    );
    const frame = lastFrame().split('\n');
    // ログ領域 = 上パディング 1 行の下から、コンポーザ上ボーダー手前の余白の直前まで。
    const border = frame.findIndex((line) => line.includes('─'));
    const region = frame.slice(1, border - 1);
    expect(region.length).toBeGreaterThan(10); // sanity: ログ領域が取れている
    const leadingBlanks = region.findIndex((line) => line.trim().length > 0);
    // 上端の空白は 0〜1 行だけ（可視域の先頭行がちょうど段落間の空行のときの 1 行）。
    // 修正前はここが空行の本数ぶん（数行〜十数行）膨らんでいた。
    expect(leadingBlanks).toBeLessThanOrEqual(1);
    // 段落の区切り（空行）自体は 1 行として残っている。
    expect(region.some((line) => line.trim().length === 0)).toBe(true);
    app.unmount();
  }, 30000);

  // 詳細ビューはログのコピペのためマウス捕捉を解除しており、その状態の alt screen
  // では端末がホイールを ↑/↓ に変換して送ってくる（alternate scroll mode）。
  it('scrolls the detail log one line at a time with the arrow keys (wheel under alt screen)', async () => {
    const { app, stdin, visible } = await detailWithLog(40);
    expect(visible().at(-1)).toBe(39);

    stdin.write('\x1b[A'); // ↑ → exactly one line older
    await flush();
    const up = visible();
    expect(up.at(-1)).toBe(38);
    expectUnbrokenRun(up);

    stdin.write('\x1b[B'); // ↓ → back to the tail
    await flush();
    expect(visible().at(-1)).toBe(39);
    app.unmount();
  }, 30000);

  it('mouse-wheel reports scroll the log instead of typing into the composer', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('scroll me');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-w' }));
    await flush();

    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    // Wheel up/down SGR reports (button 64/65). They must be consumed as scroll
    // gestures, never inserted as text — the composer stays empty (placeholder shown).
    stdin.write('\x1b[<64;10;3M');
    await flush();
    stdin.write('\x1b[<65;10;3M');
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('追加の指示を入力'); // empty composer → placeholder still visible
    // Match the SGR report body (`6[45];col;row`), not the bare button number —
    // a bare `64|65` can false-match unrelated digits (e.g. the duration column).
    expect(frame).not.toMatch(/6[45];\d+;\d+/);
  });

  it('sends a follow-up from the detail composer to the live session', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('keep going');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-f' }));
    await flush();

    stdin.write('\t');
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    stdin.write('one more thing');
    await flush();
    stdin.write('\r'); // submit follow-up → manager.send → 'user' log entry
    await flush();
    expect(lastFrame()).toContain('one more thing');
  });

  it('/model in the detail view switches the model for that session only', async () => {
    const { manager, out } = drivenManager();
    const { stdin, lastFrame } = render(
      <App manager={manager} modelCatalog={Promise.resolve(MODEL_CATALOG)} />,
    );
    stdin.write('switch my model');
    await flush();
    stdin.write('\r');
    await flush();
    // Session starts resolved to Opus (from system/init).
    out.push(
      asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-model', model: 'claude-opus-4-8' }),
    );
    await flush();
    expect(lastFrame()).toContain('Opus 4.8');

    stdin.write('\t'); // focus list
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    // Type /model → the command palette hints it, Enter opens the picker.
    stdin.write('/model');
    await flush();
    expect(lastFrame()).toContain('/model');
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain(messages.ja.model.title); // model picker open

    // Rows come from the injected catalog (SDK display names). The session reports
    // `claude-opus-4-8` while the catalog row is `claude-opus-4-8[1m]`, so this also
    // covers the tag-insensitive match — the cursor must start on Opus, not Default.
    stdin.write('\x1b[B'); // ↓ → Fable
    await flush();
    stdin.write('\r'); // confirm
    await flush();

    // Back to the list: the row now shows the switched model.
    stdin.write('\x1b'); // Esc → list
    await flush();
    expect(lastFrame()).toContain('Fable 5');
    expect(lastFrame()).not.toContain('Opus 4.8');
    // The global default for new sessions is untouched.
    expect(manager.getModel()).toBeUndefined();
  });

  it('merges from the detail actions panel (Tab → m → y)', async () => {
    const merge = vi.fn(async () => {});
    const { manager, out } = drivenManager({ merge });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('finish up');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-m' }));
    out.push(asMsg({ type: 'result', subtype: 'success', result: 'done' }));
    await flush();

    stdin.write('\t'); // focus list
    await flush();
    stdin.write('\r'); // open detail
    await flush();
    stdin.write('\t'); // input panel → actions panel
    await flush();
    expect(lastFrame()).toContain('操作');
    stdin.write('m'); // merge → confirm
    await flush();
    expect(lastFrame()).toContain('マージします');
    stdin.write('y'); // confirm
    await flush();
    expect(merge).toHaveBeenCalled();
    expect(manager.get('1')?.status).toBe('archived');
  });

  it('/diff toggles the changes summary (hidden by default) in the detail view', async () => {
    const diffStat = async () => ({ committed: 'M src/foo.ts', uncommitted: [] });
    const { manager, out } = drivenManager({ diffStat });
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('show me diffs');
    await flush();
    stdin.write('\r');
    await flush();
    // Reach a terminal state so the diff summary becomes available.
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-diff' }));
    out.push(asMsg({ type: 'result', subtype: 'success', result: 'done' }));
    await flush();

    stdin.write('\t'); // focus list
    await flush();
    stdin.write('\r'); // open detail
    await flush();

    // Hidden by default: the log gets the vertical room, no changes summary.
    expect(lastFrame()).not.toContain('M src/foo.ts');

    // /diff reveals it.
    stdin.write('/diff');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('M src/foo.ts');

    // /diff again hides it.
    stdin.write('/diff');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).not.toContain('M src/foo.ts');
  });
});

describe('App one-key resume', () => {
  /**
   * A manager whose sessions sit in a cut-off status and record their `send()`
   * calls. `send` flips the session to `running` and reports it, exactly like the
   * real `Session.send` (synchronously, before the UI's throttled subscription
   * catches up) — that is what makes the repeated-keypress tests meaningful.
   * `statusOf` decides each session's status from its 1-based index so a mixed set
   * (interrupted + needs_login) can be built.
   */
  function stalledManager(
    statusOf: SessionState['status'] | ((i: number) => SessionState['status']),
  ) {
    const sends: { id: string; text: string }[] = [];
    const manager = new SessionManager({
      worktrees,
      queryFn: (() => {
        throw new Error('unused');
      }) as never,
      now: () => 0,
      createSession: ({ input, onChange }) => {
        const session = noopSession(input);
        const status = typeof statusOf === 'function' ? statusOf(Number(input.id)) : statusOf;
        session.state = { ...session.state, status, sdkSessionId: `sdk-${input.id}` };
        session.send = (text: string) => {
          sends.push({ id: input.id, text });
          session.state = { ...session.state, status: 'running' };
          onChange(session.state);
        };
        return session;
      },
    });
    return { manager, sends };
  }

  /** Create `n` sessions through the composer (each lands in the stalled status). */
  async function seed(stdin: { write: (s: string) => void }, n: number) {
    for (let i = 0; i < n; i++) {
      stdin.write(`task-${i}`);
      await flush();
      stdin.write('\r');
      await flush();
    }
  }

  it('resumes the selected session with a single key from the composer', async () => {
    const { manager, sends } = stalledManager('interrupted');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 1);

    // 既定フォーカスは入力欄。そこに Ctrl+R の案内が出ていて、Tab を挟まずに効く。
    expect(lastFrame()).toContain(messages.ja.resume.oneKeyHint);
    stdin.write('\x12'); // Ctrl+R
    await flush();
    expect(sends).toEqual([{ id: '1', text: messages.ja.resume.instruction }]);
  });

  it('tells Claude the login was renewed when resuming a needs_login session', async () => {
    const { manager, sends } = stalledManager('needs_login');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 1);

    // 認証切れは「別ターミナルでログイン → Ctrl+R」の手順そのものを出す。
    expect(lastFrame()).toContain('/login');
    stdin.write('\x12');
    await flush();
    expect(sends).toEqual([{ id: '1', text: messages.ja.resume.authInstruction }]);
  });

  it('does nothing when the selected session is not cut off', async () => {
    const { manager, sends } = stalledManager('running');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 1);

    expect(lastFrame()).not.toContain(messages.ja.resume.oneKeyHint);
    stdin.write('\x12');
    await flush();
    expect(sends).toEqual([]);
  });

  it('resumes from the detail view without opening the actions panel', async () => {
    const { manager, sends } = stalledManager('interrupted');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 1);
    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('\r'); // open the detail view (composer has focus there)
    await flush();

    expect(lastFrame()).toContain(messages.ja.resume.oneKeyHint);
    stdin.write('\x12');
    await flush();
    expect(sends).toEqual([{ id: '1', text: messages.ja.resume.instruction }]);
  });

  it('resumes every cut-off session at once after confirming (Ctrl+A → y)', async () => {
    // 回線が落ちる・蓋を閉じると走っていたセッションが揃って中断されるので、
    // 1件ずつ押し直させない。
    const { manager, sends } = stalledManager('interrupted');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 3);

    expect(lastFrame()).toContain(messages.ja.resume.allHint(3));
    stdin.write('\x01'); // Ctrl+A
    await flush();
    // 一括は課金に直結するので件数を見せて確認する（単体の Ctrl+R は確認なし）。
    expect(lastFrame()).toContain(messages.ja.action.resumeAllPrompt(3, 0));
    expect(sends).toEqual([]);
    stdin.write('y');
    await flush();
    expect(sends.map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(sends.every((s) => s.text === messages.ja.resume.instruction)).toBe(true);
  });

  it('cancels the bulk resume on n (nothing is sent)', async () => {
    const { manager, sends } = stalledManager('interrupted');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 2);
    stdin.write('\x01');
    await flush();
    stdin.write('n');
    await flush();
    expect(lastFrame()).not.toContain(messages.ja.action.resumeAllPrompt(2, 0));
    expect(sends).toEqual([]);
  });
  it('ignores a held-down resume key: the instruction is sent once', async () => {
    // ストア購読は ~100ms スロットルなので、送信直後もビュー側の status は
    // `interrupted` に見える。連打・オートリピートで同じ指示を積むと二重課金＋
    // transcript にユーザー発話が二重に残る。
    const { manager, sends } = stalledManager('interrupted');
    const { stdin } = render(<App manager={manager} />);
    await seed(stdin, 1);
    stdin.write('\x12');
    stdin.write('\x12');
    stdin.write('\x12');
    await flush();
    expect(sends).toHaveLength(1);
  });

  it('still resumes with r from the list focus (the pre-existing key)', async () => {
    const { manager, sends } = stalledManager('interrupted');
    const { stdin } = render(<App manager={manager} />);
    await seed(stdin, 1);
    stdin.write('\t'); // focus the list
    await flush();
    stdin.write('r');
    stdin.write('r'); // 連打しても1回だけ
    await flush();
    expect(sends).toEqual([{ id: '1', text: messages.ja.resume.instruction }]);
  });

  it('sends each bulk-resumed session the instruction that matches its status, once', async () => {
    // 認証切れには「ログインし直した」版を送る（通信断の文言では嘘になる）。
    const { manager, sends } = stalledManager((i) => (i === 2 ? 'needs_login' : 'interrupted'));
    const { stdin, lastFrame } = render(<App manager={manager} />);
    await seed(stdin, 3);
    stdin.write('\x01'); // Ctrl+A
    await flush();
    // 認証切れが混ざるので、確認文でログインを先に済ませるよう促す（枠内で折り返す
    // ため、行に分断されない断片で判定する）。
    expect(lastFrame()).toContain('認証切れ 1 件を含む');
    stdin.write('y');
    stdin.write('y'); // 連打しても各セッション1回だけ
    await flush();
    expect(sends).toEqual([
      { id: '1', text: messages.ja.resume.instruction },
      { id: '2', text: messages.ja.resume.authInstruction },
      { id: '3', text: messages.ja.resume.instruction },
    ]);
  });

  it('keeps the hint, composer and footer visible on a short terminal', async () => {
    // 案内行を足したぶん、Yoga が「溢れた子を縮小する」経路に入りやすくなる。
    // flexShrink={0} が無いと案内自体が高さ0に潰れ、入力欄の枠も崩れる。
    const { manager } = stalledManager('interrupted');
    for (let i = 0; i < 3; i++) {
      manager.create(`task-${i}`);
    }
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 16, 100);
    const frame = lastFrame();
    expect(frame.split('\n')).toHaveLength(16);
    expect(frame).toContain(messages.ja.resume.oneKeyHint);
    expect(frame).toContain(messages.ja.resume.allHint(3));
    expect(frame).toContain(messages.ja.list.promptPlaceholder);
    // 最下段はフッタ（モード行）— 案内行を足しても押し出されない。
    expect(
      frame
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1),
    ).toContain('shift+tab');
    app.unmount();
  });
});

describe('PR セル（GitHub ステータスの表示）', () => {
  /**
   * A manager whose sessions apply `pr` / `pr_lookup` events through the real
   * reducer, so a test drives the actual coordinator → reducer → UI path.
   */
  /**
   * Shared clock so a test can jump past a PR's freshness window — `refreshPrs()`
   * reuses the cached value until then (see core/pr-refresh.ts).
   */
  const clock = { value: 0 };
  const staleTick = () => {
    clock.value += PR_POLL_STABLE_MS;
  };

  function prManager(lookupPr: PrLookup, seed: Partial<SessionState> = {}) {
    clock.value = 0;
    return new SessionManager({
      worktrees,
      queryFn: (() => {
        throw new Error('unused');
      }) as never,
      now: () => clock.value,
      lookupPr,
      createSession: ({ input, onChange }) => {
        const session = noopSession(input);
        session.state = { ...session.state, status: 'completed', ...seed };
        session.setPr = (pr) => {
          session.state = reduce(session.state, { kind: 'pr', pr, at: clock.value });
          onChange(session.state);
        };
        session.setPrLookup = (lookup) => {
          session.state = reduce(session.state, { kind: 'pr_lookup', lookup, at: clock.value });
          onChange(session.state);
        };
        return session;
      },
    });
  }

  const PR = { number: 42, url: 'https://x/pull/42', mergeStatus: 'mergeable' as const };

  /**
   * The list re-renders on a ~100ms store throttle, so a single flush() can race
   * under load. Poll the frame until it satisfies `ok`, then hand it back for the
   * real assertion (which still fails with a readable diff if it never settles).
   */
  async function settledFrame(
    lastFrame: () => string | undefined,
    ok: (frame: string) => boolean,
  ): Promise<string> {
    let frame = stripAnsi(lastFrame() ?? '');
    for (let i = 0; i < 30 && !ok(frame); i++) {
      await flush(50);
      frame = stripAnsi(lastFrame() ?? '');
    }
    return frame;
  }

  it('marks the cell 読み込み中 while the first `gh` lookup is in flight', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const manager = prManager(async () => {
      await gate;
      return { kind: 'found', pr: PR };
    });
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);

    const refreshed = manager.refreshPrs();
    // 空セルは「PR が無い」を意味するので、確認中はそれと区別できる印を出す。
    expect(await settledFrame(lastFrame, (f) => f.includes(glyph.prLoading))).toContain(
      glyph.prLoading,
    );

    release();
    await refreshed;
    const frame = await settledFrame(lastFrame, (f) => f.includes('#42'));
    expect(frame).toContain('#42');
    expect(frame).not.toContain(glyph.prLoading);
    app.unmount();
  });

  // 「番号が分かった時点で番号を表示、ステータスが分かった時点でステータスを表示」
  // 再起動直後は番号だけ復元済み（ステータスは永続しない）ので、グリフ無しの `#42` を
  // 先に出し、最初のポーリングでグリフが付く。
  it('renders a known number before its status is known, then adds the glyph', async () => {
    let result: PrLookupResult = { kind: 'found', pr: { ...PR, checks: 'pending' } };
    // Seeded like a session restored from state.json: identity only, no status.
    const manager = prManager(async () => result, { pr: { number: 42, url: 'https://x/pull/42' } });
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);

    const before = await settledFrame(lastFrame, (f) => f.includes('#42'));
    expect(before).toContain('#42');
    // No status yet → no glyph, and definitely not the "couldn't check" mark.
    expect(before).not.toContain(`${glyph.checksPending} #42`);
    expect(before).not.toContain(glyph.prUnknown);

    await manager.refreshPrs();
    const pending = `${glyph.checksPending} #42`;
    expect(await settledFrame(lastFrame, (f) => f.includes(pending))).toContain(pending);

    // A later failure keeps both halves (nothing authoritative said otherwise).
    result = { kind: 'unavailable', reason: 'network' };
    staleTick();
    await manager.refreshPrs();
    expect(await settledFrame(lastFrame, (f) => f.includes(pending))).toContain(pending);
    app.unmount();
  });

  it('leaves the cell empty when the branch genuinely has no PR', async () => {
    const manager = prManager(async () => ({ kind: 'absent' }));
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);
    await manager.refreshPrs();
    const frame = await settledFrame(lastFrame, (f) => !f.includes(glyph.prLoading));
    expect(frame).not.toContain(glyph.prLoading);
    expect(frame).not.toContain(glyph.prUnknown);
    app.unmount();
  });

  // 実際に起きていた不具合: レート制限や通信断で `gh` が失敗すると「PR 無し」と
  // 同じ扱いになり、出ていた #<n> が消えていた。失敗時は前回値を残し、印を出す。
  it('keeps a known PR and flags it when a later lookup fails', async () => {
    let result: PrLookupResult = { kind: 'found', pr: PR };
    const manager = prManager(async () => result);
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);
    await manager.refreshPrs();
    expect(await settledFrame(lastFrame, (f) => f.includes('#42'))).toContain('#42');

    result = { kind: 'unavailable', reason: 'rate_limit' };
    staleTick();
    await manager.refreshPrs();
    await flush();
    // 番号は消えない（消えるのが今回直した不具合）。
    expect(await settledFrame(lastFrame, (f) => f.includes('#42'))).toContain('#42');
    app.unmount();
  });

  it('shows 不明 when there is no PR to fall back on and the lookup failed', async () => {
    const manager = prManager(async () => ({ kind: 'unavailable', reason: 'rate_limit' }));
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);
    await manager.refreshPrs();
    expect(await settledFrame(lastFrame, (f) => f.includes(glyph.prUnknown))).toContain(
      glyph.prUnknown,
    );
    app.unmount();
  });

  it('shows the checks glyph while CI runs, and the merge glyph once it passes', async () => {
    let result: PrLookupResult = { kind: 'found', pr: { ...PR, checks: 'pending' } };
    const manager = prManager(async () => result);
    manager.create('task');
    await flush();
    const { app, lastFrame } = renderFullscreen(<App manager={manager} />, 20, 100);
    await manager.refreshPrs();
    const pending = `${glyph.checksPending} #42`;
    expect(await settledFrame(lastFrame, (f) => f.includes(pending))).toContain(pending);

    result = { kind: 'found', pr: { ...PR, checks: 'failing' } };
    staleTick();
    await manager.refreshPrs();
    const failing = `${glyph.conflicting} #42`;
    expect(await settledFrame(lastFrame, (f) => f.includes(failing))).toContain(failing);

    result = { kind: 'found', pr: { ...PR, checks: 'passing' } };
    staleTick();
    await manager.refreshPrs();
    const passing = `${glyph.mergeable} #42`;
    expect(await settledFrame(lastFrame, (f) => f.includes(passing))).toContain(passing);
    app.unmount();
  });
});
