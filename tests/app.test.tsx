import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { AsyncQueue } from '@/core/async-queue';
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

describe('App (list view)', () => {
  it('renders the banner and empty-state hint', () => {
    const { lastFrame } = render(<App manager={makeManager()} />);
    expect(lastFrame()).toContain('codiva');
    expect(lastFrame()).toContain('最初のセッション');
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
    expect(lastFrame()).toContain('1 session');
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
});
