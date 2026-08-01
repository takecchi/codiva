import { describe, expect, it } from 'vitest';
import { messages } from './i18n';
import {
  ciFixInstruction,
  MAX_FAILING_CHECKS,
  prRecovered,
  prStuckKind,
  type RecoveryKind,
  type RecoveryOutcome,
  recoverableSessions,
  recoveryKindFor,
  recoveryNotice,
  stuckKinds,
  syncInstruction,
} from './pr-recovery';
import { initialState } from './status-reducer';
import type { PrStatus, SessionState, SessionStatus } from './types';

const m = messages.ja;

function session(over: Partial<SessionState> = {}): SessionState {
  return {
    ...initialState({
      id: '1',
      title: 't',
      prompt: 'p',
      branch: 'codiva/x',
      worktreePath: '/wt/x',
      startedAt: 0,
    }),
    status: 'completed',
    ...over,
  };
}

const PR = { number: 7, url: 'https://example.test/pr/7' };

describe('prStuckKind', () => {
  const cases: { name: string; pr?: typeof PR; prStatus?: PrStatus; want?: RecoveryKind }[] = [
    { name: 'no PR at all', want: undefined },
    { name: 'PR but no status yet', pr: PR, want: undefined },
    { name: 'clean and green', pr: PR, prStatus: { mergeStatus: 'mergeable', checks: 'passing' } },
    { name: 'conflicting', pr: PR, prStatus: { mergeStatus: 'conflicting' }, want: 'sync' },
    {
      name: 'failing checks',
      pr: PR,
      prStatus: { mergeStatus: 'mergeable', checks: 'failing' },
      want: 'ci',
    },
    {
      // ベースを取り込めばチェックは回り直すので、競合を先に解く。
      name: 'conflicting wins over failing checks',
      pr: PR,
      prStatus: { mergeStatus: 'conflicting', checks: 'failing' },
      want: 'sync',
    },
    {
      name: 'merged is never stuck',
      pr: PR,
      prStatus: { mergeStatus: 'merged', checks: 'failing' },
      want: undefined,
    },
    { name: 'checks pending', pr: PR, prStatus: { mergeStatus: 'unknown', checks: 'pending' } },
  ];
  it.each(cases)('$name', ({ pr, prStatus, want }) => {
    expect(prStuckKind(session({ pr, prStatus }))).toBe(want);
  });
});

describe('stuckKinds', () => {
  it('returns every applicable kind, competition-first', () => {
    // 両方のときに片方しか返さないと、`autoFixCi` だけ有効な人の PR で何も起きない。
    expect(
      stuckKinds(session({ pr: PR, prStatus: { mergeStatus: 'conflicting', checks: 'failing' } })),
    ).toEqual(['sync', 'ci']);
  });

  it.each([
    { prStatus: { mergeStatus: 'conflicting' as const }, want: ['sync'] },
    { prStatus: { mergeStatus: 'mergeable' as const, checks: 'failing' as const }, want: ['ci'] },
    { prStatus: { mergeStatus: 'mergeable' as const, checks: 'passing' as const }, want: [] },
  ])('$prStatus → $want', ({ prStatus, want }) => {
    expect(stuckKinds(session({ pr: PR, prStatus }))).toEqual(want);
  });
});

describe('prRecovered (when the auto-recovery budget may be refunded)', () => {
  const cases: { name: string; prStatus?: PrStatus; want: boolean }[] = [
    { name: 'no status yet', want: false },
    {
      name: 'green and mergeable',
      prStatus: { mergeStatus: 'mergeable', checks: 'passing' },
      want: true,
    },
    {
      name: 'mergeable with no checks configured',
      prStatus: { mergeStatus: 'mergeable', checks: 'none' },
      want: true,
    },
    { name: 'merged', prStatus: { mergeStatus: 'merged' }, want: true },
    // 以下が肝: 「詰まっていない」だけでは返金しない。push 直後は必ずここを通るので、
    // 返金してしまうと上限が意味を失い、赤い→依頼→pending→赤い が無限に回る。
    {
      name: 'checks pending right after a push',
      prStatus: { mergeStatus: 'mergeable', checks: 'pending' },
      want: false,
    },
    {
      name: 'mergeability still being computed',
      prStatus: { mergeStatus: 'unknown', checks: 'passing' },
      want: false,
    },
    { name: 'still red', prStatus: { mergeStatus: 'mergeable', checks: 'failing' }, want: false },
    { name: 'still conflicting', prStatus: { mergeStatus: 'conflicting' }, want: false },
  ];
  it.each(cases)('$name → $want', ({ prStatus, want }) => {
    expect(prRecovered(session({ pr: PR, prStatus }))).toBe(want);
  });
});

describe('recoveryKindFor', () => {
  const stuck = { pr: PR, prStatus: { mergeStatus: 'conflicting' as const } };
  const cases: { status: SessionStatus; want?: RecoveryKind }[] = [
    { status: 'completed', want: 'sync' },
    { status: 'failed', want: 'sync' },
    { status: 'interrupted', want: 'sync' },
    { status: 'conflict', want: 'sync' },
    // 走っている最中に指示を割り込ませない（そのターンの作業と競合するだけ）。
    { status: 'running', want: undefined },
    { status: 'creating', want: undefined },
    { status: 'awaiting_input', want: undefined },
    { status: 'awaiting_permission', want: undefined },
    { status: 'archived', want: undefined },
  ];
  it.each(cases)('$status → $want', ({ status, want }) => {
    expect(recoveryKindFor(session({ ...stuck, status }))).toBe(want);
  });

  it('走行中でも「詰まっている」ことは prStuckKind が答える（カウンタのリセット判定用）', () => {
    const running = session({ ...stuck, status: 'running' });
    expect(recoveryKindFor(running)).toBeUndefined();
    expect(prStuckKind(running)).toBe('sync');
  });
});

describe('recoverableSessions', () => {
  it('一覧順を保ったまま対象と種類を返す', () => {
    const list = [
      session({ id: 'a', pr: PR, prStatus: { mergeStatus: 'mergeable', checks: 'passing' } }),
      session({ id: 'b', pr: PR, prStatus: { mergeStatus: 'mergeable', checks: 'failing' } }),
      session({ id: 'c', status: 'running', pr: PR, prStatus: { mergeStatus: 'conflicting' } }),
      session({ id: 'd', pr: PR, prStatus: { mergeStatus: 'conflicting' } }),
    ];
    expect(recoverableSessions(list).map((r) => [r.state.id, r.kind])).toEqual([
      ['b', 'ci'],
      ['d', 'sync'],
    ]);
  });
});

describe('syncInstruction', () => {
  it('競合したら競合ファイルを添えて指示を出す', () => {
    const text = syncInstruction(
      { kind: 'conflict', ref: 'origin/main', files: ['a.ts', 'b.ts'] },
      'main',
      m,
    );
    expect(text).toContain('a.ts, b.ts');
    expect(text).toContain('main');
  });

  it('未コミットがあるときは取り込みごとエージェントに任せる', () => {
    const text = syncInstruction({ kind: 'dirty', files: ['x.ts'] }, 'main', m);
    expect(text).toContain('x.ts');
  });

  it.each([
    { kind: 'upToDate' } as const,
    { kind: 'updated', ref: 'origin/main' } as const,
    // 成功系はセッションを起こさない（= トークンを使わない）ことが要件。
  ])('$kind は指示を出さない', (result) => {
    expect(syncInstruction(result, 'main', m)).toBeUndefined();
  });
});

describe('ciFixInstruction', () => {
  it('失敗したチェック名と URL を載せる', () => {
    const text = ciFixInstruction(
      'feat/x',
      [{ name: 'CI / lint', url: 'https://example.test/run/1' }],
      m,
    );
    expect(text).toContain('feat/x');
    expect(text).toContain('CI / lint (https://example.test/run/1)');
  });

  it('チェック名が取れなくても手順は渡す', () => {
    expect(ciFixInstruction('feat/x', undefined, m)).toContain('gh run view');
  });

  it('matrix の全落ちでプロンプトを埋めない（上限で切る）', () => {
    const many = Array.from({ length: MAX_FAILING_CHECKS + 5 }, (_, i) => ({ name: `job-${i}` }));
    const text = ciFixInstruction('feat/x', many, m);
    expect(text).toContain(`job-${MAX_FAILING_CHECKS - 1}`);
    expect(text).not.toContain(`job-${MAX_FAILING_CHECKS}`);
  });
});

describe('recoveryNotice', () => {
  const cases: { outcome: RecoveryOutcome; want: string | undefined }[] = [
    { outcome: { kind: 'synced' }, want: m.recover.synced },
    { outcome: { kind: 'upToDate' }, want: m.recover.upToDate },
    { outcome: { kind: 'delegated', recovery: 'sync' }, want: m.recover.delegatedSync },
    { outcome: { kind: 'delegated', recovery: 'ci' }, want: m.recover.delegatedCi },
    { outcome: { kind: 'skipped' }, want: m.recover.skipped },
    { outcome: { kind: 'busy' }, want: m.recover.busySession },
    // エラーは呼び出し側がエラー欄へ出すので、通知としては何も返さない。
    { outcome: { kind: 'error', error: 'boom' }, want: undefined },
  ];
  it.each(cases)('$outcome.kind', ({ outcome, want }) => {
    expect(recoveryNotice(outcome, m)).toBe(want);
  });
});
