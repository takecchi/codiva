import { spawn } from 'node:child_process';
import type { AgentLoginProcess } from '@/core';
import { childProcessEnv } from './child-env';

/**
 * `<cli> login ...` を起動する provider 非依存の I/O。stdout/stderr を行で流し、
 * 終了コードを返す（進行の解釈は `core/agent-login.ts`、UI は `ui/login-dialog.tsx`）。
 *
 * **端末は明け渡さない**: stdin は空（`'ignore'`）で、出力だけをパイプで受ける。
 * 認証はブラウザ側で進む（codiva は出力の URL を拾って開く）。デバイスコードフロー
 * （`codex login --device-auth`）のように stdin を要らない経路を選ぶのはアダプタの責任。
 */

/** 1 行の上限（暴走出力でヒープを食わない）。 */
const MAX_LINE_CHARS = 64 * 1024;

/**
 * 未消費のまま溜めておける行数の上限。CLI が消費側（ダイアログの再描画）より速く
 * 吐き続けても配列が無限に伸びないようにする。溢れたら**古い行から捨てる**
 * （表示側 `appendLoginLine` も直近 `MAX_LOGIN_LINES` 行しか持たず、失敗理由に使うのは
 * 最後の非空行なので、末尾を残す方が失われる情報が少ない）。
 */
const MAX_QUEUED_LINES = 1000;

export function spawnLogin(command: string, args: readonly string[]): AgentLoginProcess {
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childProcessEnv(),
  });

  let code: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    spawnError = err;
  });
  // stdout/stderr のパイプエラー（kill 前後の EPIPE 等）で TUI を落とさない。
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  async function* lines(): AsyncGenerator<string> {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // 2 本のストリームを 1 本の行ストリームへマージする。片方が終わっても他方を待つ。
    const queue: string[] = [];
    let resolveNext: (() => void) | undefined;
    let openStreams = 0;
    const wake = () => {
      resolveNext?.();
      resolveNext = undefined;
    };
    const push = (line: string) => {
      queue.push(line);
      if (queue.length > MAX_QUEUED_LINES) {
        queue.splice(0, queue.length - MAX_QUEUED_LINES);
      }
    };
    const attach = (stream: NodeJS.ReadableStream | null | undefined) => {
      if (!stream) {
        return;
      }
      openStreams += 1;
      // **行バッファはストリームごとに持つ**。共有すると、改行で終わっていない
      // stdout の途中チャンクの後ろへ stderr の行が連結され、1 行に混線する
      // （`Open https://example.com/` + `warning: ...` → URL 抽出が壊れる。issue #113）。
      let buffer = '';
      const pump = (chunk: string): string[] => {
        buffer += chunk;
        const out: string[] = [];
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          out.push(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
        if (buffer.length > MAX_LINE_CHARS) {
          // 改行の来ない長大な 1 行は諦める（切って流す）。
          out.push(buffer.slice(0, MAX_LINE_CHARS));
          buffer = '';
        }
        return out;
      };
      stream.on('data', (chunk: string) => {
        for (const line of pump(chunk)) {
          push(line);
        }
        wake();
      });
      // end / error は片方しか来ないのが普通だが、両方来ても二重に減らさない。
      let closed = false;
      const finish = () => {
        if (closed) {
          return;
        }
        closed = true;
        // そのストリームの残り（改行で終わっていない最後の行）だけを流す。
        if (buffer.trim().length > 0) {
          push(buffer);
        }
        buffer = '';
        openStreams -= 1;
        wake();
      };
      stream.on('end', finish);
      stream.on('error', finish);
    };
    attach(child.stdout);
    attach(child.stderr);

    while (openStreams > 0 || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        continue;
      }
      const line = queue.shift();
      if (line !== undefined) {
        yield line;
      }
    }
    code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.once('close', (c) => resolve(c));
      child.once('exit', (c) => resolve(c));
    });
  }

  return {
    [Symbol.asyncIterator]: () => lines()[Symbol.asyncIterator](),
    cancel: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    },
    result: () => ({ code: spawnError ? (code ?? 1) : code }),
  };
}
