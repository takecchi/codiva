import { spawn } from 'node:child_process';

export interface LaunchResult {
  ok: boolean;
  error?: string;
}

export interface ClaudeLaunch {
  /** The session's worktree — claude resolves the transcript store from cwd. */
  cwd: string;
  /** SDK session id to resume (`claude --resume <id>`). */
  sessionId: string;
}

/** spawn と同じ形のファクトリ（テストでフェイクを注入するための最小型）。 */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: 'inherit' },
) => {
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
};

/**
 * Open a session in the interactive claude CLI, inheriting the terminal, and
 * resolve when it exits. Ink 側は suspendTerminal で描画・入力を明け渡しておく
 * こと。非ゼロ終了はエラー扱いしない（ユーザーが Ctrl+C で抜けるのは正常系）。
 * spawn 自体の失敗（claude 未インストール等）だけを error として返す。
 */
export function launchClaudeSession(
  { cwd, sessionId }: ClaudeLaunch,
  spawnFn: SpawnLike = spawn,
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const child = spawnFn('claude', ['--resume', sessionId], { cwd, stdio: 'inherit' });
    child.once('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.once('exit', () => {
      resolve({ ok: true });
    });
  });
}
