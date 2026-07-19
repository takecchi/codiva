import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { launchClaudeSession, type SpawnLike } from './claude-cli';

function fakeSpawn(drive: (child: EventEmitter) => void): {
  spawnFn: SpawnLike;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const spawnFn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const child = new EventEmitter();
    queueMicrotask(() => drive(child));
    return child as unknown as ReturnType<SpawnLike>;
  };
  return { spawnFn, calls };
}

describe('launchClaudeSession', () => {
  it('runs `claude --resume <id>` in the worktree and resolves ok on exit', async () => {
    const { spawnFn, calls } = fakeSpawn((child) => child.emit('exit', 0));
    const result = await launchClaudeSession({ cwd: '/wt/a', sessionId: 'sdk-1' }, spawnFn);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ command: 'claude', args: ['--resume', 'sdk-1'], cwd: '/wt/a' }]);
  });

  it('non-zero exit is still ok (user may quit claude with Ctrl+C)', async () => {
    const { spawnFn } = fakeSpawn((child) => child.emit('exit', 130));
    await expect(launchClaudeSession({ cwd: '/wt', sessionId: 's' }, spawnFn)).resolves.toEqual({
      ok: true,
    });
  });

  it('reports a spawn failure (claude not installed) as an error', async () => {
    const { spawnFn } = fakeSpawn((child) => child.emit('error', new Error('spawn claude ENOENT')));
    await expect(launchClaudeSession({ cwd: '/wt', sessionId: 's' }, spawnFn)).resolves.toEqual({
      ok: false,
      error: 'spawn claude ENOENT',
    });
  });
});
