import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import type { ReactElement } from 'react';
import { SessionManager } from '@/core/session-manager';
import type { SessionHandle, WorktreeService } from '@/core/session-ports';
import { initialState } from '@/core/status-reducer';
import type { CreateSessionInput, SessionState } from '@/core/types';

/** Resolve after `ms` so background provisioning/state updates settle between steps. */
export const flush = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * ストアの購読がまとめられる窓（`useSessions` の ~100ms）。`settle` の「静かだった」
 * 判定はこれより長くないと、まだ続きが来る途中の隙間を「落ち着いた」と誤読する。
 */
const STORE_COALESCE_MS = 100;

/**
 * 描画が**変わらなくなるまで**待つ（最後のフレームが `quietMs` 以上変化しない or
 * `timeoutMs` 経過）。
 *
 * 固定の `flush(150)` は「150ms あれば全部落ち着く」という賭けで、遅い CI で負ける。
 * 実際に 1 度だけ、詳細ログのドラッグ選択がコピーを 1 件も出さずに落ちた
 * （`copied` が `[]`。ローカルでは再現せず、同じコミットの PR / tag のジョブは緑）。
 * この種のテストは**フレームから座標を割り出して**クリックを合成するので、押した
 * 時点のアプリの幾何（`logView`）がそのフレームと同じでなければ当たり判定が別の行に
 * 落ちる — つまり「まだ描き変わる余地があるうちに触る」ことが失敗の条件になる。
 *
 * ここでは待ち時間を固定値の賭けにせず、**静止するまで待つ**ようにする（遅い環境では
 * 自然に長く待ち、速い環境では従来と同じくらいで返る）。静止の窓は
 * {@link STORE_COALESCE_MS} より長くとる: ストア更新はまとめられて届くので、
 * 60ms 程度の静けさは「まだ続きがある」ことと区別できない。
 */
export async function settle(
  lastFrame: () => string,
  { quietMs = STORE_COALESCE_MS + 60, tickMs = 25, timeoutMs = 5_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = lastFrame();
  let quiet = 0;
  while (Date.now() < deadline) {
    await flush(tickMs);
    const current = lastFrame();
    if (current === previous) {
      quiet += tickMs;
      if (quiet >= quietMs) {
        return;
      }
      continue;
    }
    previous = current;
    quiet = 0;
  }
}

// 制御文字を正規表現リテラルに直接書くと Biome の noControlCharactersInRegex に触れるので組み立てる。
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
/**
 * OSC（`ESC ] … BEL` / `ESC ] … ESC \\`）。詳細ログの URL は OSC 8 ハイパーリンクで
 * 包まれて出るので、これを外さないと**エスケープの中の URL 文字列**が
 * `indexOf` に引っかかり、そこから求めた列は表示位置とまるで違う場所になる。
 */
const OSC = new RegExp(`${ESC}\\][\\s\\S]*?(?:${String.fromCharCode(7)}|${ESC}\\\\)`, 'g');

/**
 * Drop SGR (color/style) and OSC escapes from a frame. Necessary whenever a test
 * derives a *column* from `lastFrame()` (e.g. to synthesize a mouse report): with
 * colors (or OSC 8 links) enabled the raw string index includes escape sequences,
 * so the click would land somewhere else entirely.
 */
export function stripAnsi(frame: string): string {
  return frame.replace(OSC, '').replace(SGR, '');
}

/** A no-op WorktreeService that reports predictable slugs/paths for the fakes. */
export const fakeWorktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/${slug}` }),
  syncedStartPoint: async () => undefined,
  pushBranch: async () => {},
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  syncBase: async () => ({ kind: 'upToDate' }),
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
    setPrLookup() {},
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
