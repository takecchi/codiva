import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';
import type { QueryFn } from '@/core/session';
import { SessionManager } from '@/core/session-manager';
import { flush, fakeWorktrees as worktrees } from './helpers';

// Integration test for Phase 6 session restoration: run → persist → new manager
// restore → resume on follow-up. Uses a real Session (driven queryFn), not a fake.
// A shorter flush window is fine here (a driven query settles fast).

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

  it('seeds the restored log from a transcript-rebuilt history (resume never re-emits it)', async () => {
    const first = drivenQuery();
    const m1 = new SessionManager({ worktrees, queryFn: first.queryFn, now: () => 0 });
    m1.create('add a login page');
    await flush();
    first.out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-restore-2' }));
    first.out.push(asMsg({ type: 'result', subtype: 'success', result: 'done' }));
    await flush();
    const persisted = m1.persistableState();
    m1.dispose();

    const second = drivenQuery();
    const m2 = new SessionManager({ worktrees, queryFn: second.queryFn, now: () => 0 });
    const history = [
      { seq: 1, kind: 'user' as const, text: 'add a login page' },
      { seq: 2, kind: 'assistant_text' as const, text: 'Added the login page.' },
    ];
    const id = persisted.sessions[0]?.id ?? '';
    m2.restore(persisted, new Map([[id, history]]));

    const restored = m2.get(id);
    expect(restored?.messages).toEqual(history);
    // A follow-up appends after the restored history instead of restarting at seq 1.
    m2.send(id, 'tweak the styles');
    await flush();
    const after = m2.get(id);
    expect(after?.messages.at(-1)).toMatchObject({
      seq: 3,
      kind: 'user',
      text: 'tweak the styles',
    });
  });
  // 「PR の番号はもう分かっている」— 番号は永続化して復元直後から出し、ステータス
  // （チェック・マージ可否）は復元後の最初のポーリングで埋める。
  it('carries the PR number across a restart and fills the status in on the first poll', async () => {
    const first = drivenQuery();
    const m1 = new SessionManager({
      worktrees,
      queryFn: first.queryFn,
      now: () => 0,
      // A PR is detected during the first run, with its checks still running.
      lookupPr: async () => ({
        kind: 'found' as const,
        pr: {
          number: 42,
          url: 'https://x/pull/42',
          mergeStatus: 'unknown' as const,
          checks: 'pending' as const,
        },
      }),
    });
    m1.create('add a login page');
    await flush();
    first.out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-restore-3' }));
    first.out.push(asMsg({ type: 'result', subtype: 'success', result: 'done' }));
    await flush();
    const id = m1.getSnapshot()[0]?.id ?? '';
    await m1.refreshPrs();
    expect(m1.get(id)?.prStatus).toEqual({ mergeStatus: 'unknown', checks: 'pending' });
    const persisted = m1.persistableState();
    m1.dispose();

    // The stable half is on disk; the volatile half deliberately is not.
    expect(persisted.sessions[0]?.pr).toEqual({ number: 42, url: 'https://x/pull/42' });
    expect(JSON.stringify(persisted)).not.toContain('pending');

    const lookupPr = vi.fn(async () => ({
      kind: 'found' as const,
      pr: {
        number: 42,
        url: 'https://x/pull/42',
        mergeStatus: 'mergeable' as const,
        checks: 'passing' as const,
      },
    }));
    const second = drivenQuery();
    const m2 = new SessionManager({
      worktrees,
      queryFn: second.queryFn,
      now: () => 0,
      lookupPr,
    });
    m2.restore(persisted);

    // Before any lookup: the number is already there, the status isn't — so the row
    // shows `#42` with no glyph instead of "unknown".
    const restored = m2.get(id);
    expect(restored?.pr).toEqual({ number: 42, url: 'https://x/pull/42' });
    expect(restored?.prStatus).toBeUndefined();
    expect(restored?.prLookup).toBeUndefined();

    // The first poll is due immediately for exactly this case and fills the status in.
    await m2.refreshPrs();
    expect(lookupPr).toHaveBeenCalledTimes(1);
    const polled = m2.get(id);
    expect(polled?.pr).toEqual({ number: 42, url: 'https://x/pull/42' });
    expect(polled?.prStatus).toEqual({ mergeStatus: 'mergeable', checks: 'passing' });
  });
});
