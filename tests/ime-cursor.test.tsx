import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '@/app';
import { SessionManager, type WorktreeService } from '@/core/session-manager';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput } from '@/core/types';

// 日本語（IME）入力の e2e: 確定文字列がバッファに入り、実端末カーソルが
// キャレット位置（CJK 2セル幅を加味）に置かれることを検証する。カーソル制御は
// interactive（非 debug）レンダリングでしか書き出されないため、app.test.tsx の
// debug ヘルパではなくチャンク収集の stdout を使う。

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

class FakeStdout extends EventEmitter {
  readonly columns = 80;
  readonly rows = 20;
  readonly chunks: string[] = [];
  write = (chunk: string) => {
    this.chunks.push(chunk);
    return true;
  };
}

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

function renderInteractive(element: ReactElement) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = inkRender(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { app, stdin, output: () => stdout.chunks.join('') };
}

const ESC = String.fromCharCode(27);

function lastCursorColumn(output: string): number | undefined {
  const cursorShow = new RegExp(`${ESC}\\[(\\d+)G${ESC}\\[\\?25h`, 'g');
  const matches = [...output.matchAll(cursorShow)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : undefined;
}

describe('Japanese (IME) input', () => {
  it('an IME-committed string lands in the prompt and moves the cursor by display width', async () => {
    const { app, stdin, output } = renderInteractive(<App manager={makeManager()} />);
    await flush();
    // IME 確定時は複数文字が1チャンクで届く
    stdin.write('こんにちは');
    await flush();
    expect(output()).toContain('こんにちは');
    // SessionList padding(1) + `❯ `(2) + こんにちは(10) = 13 → 1-based column 14
    expect(lastCursorColumn(output())).toBe(14);
    app.unmount();
  });

  it('mixed ascii + japanese typed in separate chunks accumulates', async () => {
    const { app, stdin, output } = renderInteractive(<App manager={makeManager()} />);
    await flush();
    stdin.write('fix ');
    await flush();
    stdin.write('バグ');
    await flush();
    expect(output()).toContain('fix バグ');
    // padding(1) + `❯ `(2) + 'fix '(4) + バグ(4) = 11 → column 12
    expect(lastCursorColumn(output())).toBe(12);
    app.unmount();
  });

  it('Enter submits the Japanese prompt as a new session', async () => {
    const manager = makeManager();
    const { app, stdin } = renderInteractive(<App manager={manager} />);
    await flush();
    stdin.write('バグを直す');
    await flush();
    stdin.write('\r');
    await flush();
    expect(manager.getSnapshot().map((s) => s.title)).toContain('バグを直す');
    app.unmount();
  });
});
