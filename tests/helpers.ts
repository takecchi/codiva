import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';
import { SessionManager } from '@/core/session-manager';
import type { SessionHandle, WorktreeService } from '@/core/session-ports';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput, SessionState } from '@/core/types';

/** Resolve after `ms` so background provisioning/state updates settle between steps. */
export const flush = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A no-op WorktreeService that reports predictable slugs/paths for the fakes. */
export const fakeWorktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/${slug}` }),
  syncedStartPoint: async () => undefined,
  pushBranch: async () => {},
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  remove: async () => {},
};

/** A session that stays in 'creating' — enough to smoke-test rendering + wiring. */
export function noopSession(input: CreateSessionInput): SessionHandle & { state: SessionState } {
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

/** A SessionManager wired with the no-op worktrees + session (no real SDK). */
export function makeManager(): SessionManager {
  return new SessionManager({
    worktrees: fakeWorktrees,
    queryFn: (() => {
      throw new Error('unused');
    }) as never,
    now: () => 0,
    createSession: ({ input }) => noopSession(input),
  });
}

/**
 * ink-testing-library の fake stdout は rows を注入できない（実端末サイズに
 * フォールバックして非決定的になる）ため、全画面テストは Ink 本体の render に
 * 寸法固定のストリームを渡して検証する。
 */
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

/** ink-testing-library の Stdin と同じ挙動（write → 'readable'/'data' を emit）。 */
export class FakeStdin extends EventEmitter {
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
    const value = this.data;
    this.data = null;
    return value;
  };
}

/** Render `element` through Ink itself with a fixed-size stdout/stdin (fullscreen tests). */
export function renderFullscreen(element: ReactElement, rows = 20, columns = 80) {
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
