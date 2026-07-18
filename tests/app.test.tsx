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
    abort() {},
    stop() {},
    archive() {},
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
  readonly columns = 80;
  readonly rows: number;
  readonly frames: string[] = [];
  constructor(rows = 20) {
    super();
    this.rows = rows;
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

function renderFullscreen(element: ReactElement, rows = 20) {
  const stdout = new FakeStdout(rows);
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
    expect(lastFrame()).toContain('codiva');
    // 入力欄+フッタが flexGrow スペーサで画面最下段（下パディングの上）に来る。
    const lastContent = lines.filter((l) => l.trim() !== '').at(-1);
    expect(lastContent).toContain('自動モード');
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

  it('detail view clips old log lines to the terminal height, newest at the bottom', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });

    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20);
    stdin.write('long task');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-t' }));
    for (let i = 0; i < 40; i += 1) {
      out.push(
        asMsg({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `log line ${i}` }] },
        }),
      );
    }
    await flush();
    stdin.write('[C'); // right arrow → detail
    await flush();

    const frame = lastFrame();
    // フレームは端末高さに収まり、ログは末尾（新しい側）だけが見える。
    expect(frame.split('\n').length).toBeLessThanOrEqual(20);
    expect(frame).toContain('log line 39');
    expect(frame).not.toContain('log line 0');
    app.unmount();
  });

  it('scrolls the detail log with PageUp/PageDown (terminal scrollback is off)', async () => {
    const out = new AsyncQueue<SDKMessage>();
    const queryFn = (() => {
      const gen = (async function* () {
        yield* out;
      })() as unknown as Query & { interrupt: () => Promise<void> };
      gen.interrupt = async () => {};
      return gen;
    }) as unknown as QueryFn;
    const manager = new SessionManager({ worktrees, queryFn, now: () => 0 });

    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20);
    stdin.write('long task');
    await flush();
    stdin.write('\r');
    await flush();
    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-scroll' }));
    for (let i = 0; i < 40; i += 1) {
      out.push(
        asMsg({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `log line ${i}` }] },
        }),
      );
    }
    await flush();
    stdin.write('\x1b[C'); // → detail
    await flush();
    expect(lastFrame()).toContain('log line 39');

    stdin.write('\x1b[5~'); // PageUp → scroll back
    await flush();
    const up = lastFrame();
    expect(up).toContain('過去ログを表示中'); // scrollback indicator
    expect(up).not.toContain('log line 39'); // newest scrolled off the bottom

    stdin.write('\x1b[6~'); // PageDown → back toward the tail
    await flush();
    stdin.write('\x1b[6~');
    await flush();
    const down = lastFrame();
    expect(down).toContain('log line 39'); // following the tail again
    expect(down).not.toContain('過去ログを表示中');
    app.unmount();
  });

  it('shows the streaming preview and enables includePartialMessages', async () => {
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

    const { app, stdin, lastFrame } = renderFullscreen(<App manager={manager} />, 20);
    stdin.write('stream it');
    await flush();
    stdin.write('\r');
    await flush();
    expect((captured as { includePartialMessages?: boolean }).includePartialMessages).toBe(true);

    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-stream' }));
    out.push(
      asMsg({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Reticulating splines' },
        },
      }),
    );
    await flush();
    stdin.write('\x1b[C'); // → detail
    await flush();
    expect(lastFrame()).toContain('Reticulating splines');
    app.unmount();
  });
});

describe('App (list view)', () => {
  it('renders the banner and empty-state hint', () => {
    const { lastFrame } = render(<App manager={makeManager()} />);
    expect(lastFrame()).toContain('codiva');
    expect(lastFrame()).toContain('最初のセッション');
  });

  it('renders in English when the en catalog is injected', () => {
    // The path index.tsx uses: resolved catalog → App messages prop → provider → components.
    const { lastFrame } = render(<App manager={makeManager()} messages={messages.en} />);
    expect(lastFrame()).toContain('Type an instruction');
    expect(lastFrame()).toContain('Ctrl+C: quit');
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

    out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-x' }));
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

  it('merges a completed session from the detail actions panel and archives it', async () => {
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

    stdin.write('[C'); // right arrow → open detail
    await flush();
    stdin.write('\t'); // Tab → actions panel
    await flush();
    expect(lastFrame()).toContain('マージ');
    stdin.write('m'); // choose merge → confirm
    await flush();
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
