import { EventEmitter } from 'node:events';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { AsyncQueue } from '@/core/async-queue';
import { messages } from '@/core/i18n';
import type { QueryFn } from '@/core/session';
import { SessionManager, type WorktreeService } from '@/core/session-manager';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput } from '@/core/types';

// Feature/integration tests: drive the whole App (list ⇄ detail) through a real
// SessionManager. Unit tests for individual modules live next to them as *.spec.ts.

const flush = () => new Promise((r) => setTimeout(r, 150));

const worktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/${slug}` }),
  syncedStartPoint: async () => undefined,
  pushBranch: async () => {},
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  remove: async () => {},
};

/** Session that stays in 'creating' — enough to smoke-test rendering. */
function noopSession(input: CreateSessionInput) {
  return {
    state: initialState(input),
    getState() {
      return this.state;
    },
    start() {},
    send() {},
    answerPending() {},
    allowPending() {},
    denyPending() {},
    async interrupt() {},
    setModel() {},
    abort() {},
    stop() {},
    archive() {},
    setPr() {},
    markConflict() {},
  };
}

function makeManager() {
  return new SessionManager({
    worktrees,
    queryFn: (() => {
      throw new Error('unused');
    }) as never,
    now: () => 0,
    createSession: ({ input }) => noopSession(input),
  });
}

// ink-testing-library の fake stdout は rows を注入できない（実端末サイズに
// フォールバックして非決定的になる）ため、全画面テストは Ink 本体の render に
// 寸法固定のストリームを渡して検証する。
class FakeStdout extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  readonly frames: string[] = [];
  constructor(rows = 20, columns = 80) {
    super();
    this.rows = rows;
    this.columns = columns;
  }
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

// ink-testing-library の Stdin と同じ挙動（write → 'readable'/'data' を emit）。
class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

function renderFullscreen(element: ReactElement, rows = 20, columns = 80) {
  const stdout = new FakeStdout(rows, columns);
  const stdin = new FakeStdin();
  const app = inkRender(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    // 非TTYでは debug なしだと途中フレームが書き出されない（ink-testing-library と同じ設定）。
    debug: true,
  });
  return { app, stdin, lastFrame: () => stdout.frames.at(-1) ?? '' };
}

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
    expect(frame).not.toMatch(/64|65/); // no escape-report fragments leaked as text
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
    const { stdin, lastFrame } = render(<App manager={manager} />);
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

    // Cursor starts on the current model (Opus); ↓ moves to Fable, Enter applies.
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
