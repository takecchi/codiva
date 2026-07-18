import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';
import type { QueryFn } from '@/core/session';
import { SessionManager, type WorktreeService } from '@/core/session-manager';

// Integration test for Phase 6 session restoration: run → persist → new manager
// restore → resume on follow-up. Uses a real Session (driven queryFn), not a fake.

const flush = () => new Promise((r) => setTimeout(r, 20));

const worktrees: WorktreeService = {
  baseBranch: async () => 'main',
  takenSlugs: async () => new Set(),
  add: async (slug) => ({ slug, branch: `codiva/${slug}`, path: `/tmp/${slug}` }),
  diffStat: async () => ({ committed: '', uncommitted: [] }),
  merge: async () => {},
  remove: async () => {},
};

function drivenQuery(onStart?: (options: Options) => void) {
  const out = new AsyncQueue<SDKMessage>();
  const queryFn = ((params: { options: Options }) => {
    onStart?.(params.options);
    const gen = (async function* () {
      yield* out;
    })() as unknown as Query & { interrupt: () => Promise<void> };
    gen.interrupt = async () => {};
    return gen;
  }) as unknown as QueryFn;
  return { out, queryFn };
}

const asMsg = (m: unknown) => m as SDKMessage;

describe('session restoration', () => {
  it('persists a completed session and restores it as idle, then resumes on follow-up', async () => {
    // ── First run: create a session, drive it to completion. ──────────────
    const first = drivenQuery();
    const m1 = new SessionManager({ worktrees, queryFn: first.queryFn, now: () => 0 });
    m1.create('add a login page');
    await flush();
    first.out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-restore-1' }));
    first.out.push(
      asMsg({ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.03 }),
    );
    await flush();

    const persisted = m1.persistableState();
    expect(persisted.sessions).toHaveLength(1);
    expect(persisted.sessions[0]).toMatchObject({
      title: 'add a login page',
      sdkSessionId: 'sdk-restore-1',
      status: 'completed',
      totalCostUsd: 0.03,
    });

    // Quitting stops (not aborts) — the session stays resumable in the snapshot.
    m1.dispose();
    expect(m1.persistableState().sessions[0]?.status).toBe('completed');

    // ── Second run: a fresh manager restores from the persisted state. ────
    let resumedWith: string | undefined;
    const second = drivenQuery((options) => {
      resumedWith = (options as { resume?: string }).resume;
    });
    const m2 = new SessionManager({ worktrees, queryFn: second.queryFn, now: () => 0 });
    m2.restore(persisted);

    const restored = m2.getSnapshot();
    expect(restored).toHaveLength(1);
    const session = restored[0];
    if (!session) {
      throw new Error('expected a restored session');
    }
    expect(session).toMatchObject({ status: 'completed', title: 'add a login page' });
    // Restored session did not start a subprocess yet.
    expect(resumedWith).toBeUndefined();

    // ── Follow-up lazily starts the query with resume set to the SDK id. ──
    m2.send(session.id, 'now add password reset');
    await flush();
    expect(resumedWith).toBe('sdk-restore-1');
    expect(m2.get(session.id)?.status).toBe('running');
  });
});
