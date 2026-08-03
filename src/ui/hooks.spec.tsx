import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { FC } from 'react';
import { describe, expect, it } from 'vitest';
import { useBranch } from './hooks';

/** Resolve after `ms` so the hook's poll (and its promise) settles between steps. */
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Renders whatever `useBranch` currently holds (`-` while unresolved). */
const Probe: FC<{ load?: () => Promise<string | undefined>; intervalMs?: number }> = ({
  load,
  intervalMs,
}) => <Text>{`[${useBranch(load, intervalMs) ?? '-'}]`}</Text>;

describe('useBranch', () => {
  it('注入された取得関数の結果を返す', async () => {
    const { lastFrame, unmount } = render(<Probe load={async () => 'main'} intervalMs={10} />);
    await tick();
    expect(lastFrame()).toContain('[main]');
    unmount();
  });

  it('取得関数が無ければ undefined のまま（合成ルートが注入しない環境）', async () => {
    const { lastFrame, unmount } = render(<Probe intervalMs={10} />);
    await tick();
    expect(lastFrame()).toContain('[-]');
    unmount();
  });

  // codiva の外（別ターミナルの `git switch`）でも変わるので、初回取得だけでは古いままになる。
  it('切り替わったら次のポーリングで追従する', async () => {
    let branch: string | undefined = 'main';
    const { lastFrame, unmount } = render(<Probe load={async () => branch} intervalMs={10} />);
    await tick();
    expect(lastFrame()).toContain('[main]');
    branch = 'feature/x';
    await tick();
    expect(lastFrame()).toContain('[feature/x]');
    // detached HEAD へ移ったら表示も消える（undefined に戻る）。
    branch = undefined;
    await tick();
    expect(lastFrame()).toContain('[-]');
    unmount();
  });

  it('取得が失敗しても落ちず、直前の表示を保つ', async () => {
    let fail = false;
    const { lastFrame, unmount } = render(
      <Probe
        load={async () => {
          if (fail) {
            throw new Error('git missing');
          }
          return 'main';
        }}
        intervalMs={10}
      />,
    );
    await tick();
    expect(lastFrame()).toContain('[main]');
    fail = true;
    await tick();
    expect(lastFrame()).toContain('[main]');
    unmount();
  });

  // ヘッダを描いていない間（詳細ビュー）は `app.tsx` が load を外して取得を止める。
  // 値は保たれ、戻った時点で 1 回読み直す（戻った瞬間に表示が消えない）。
  it('load を外すとポーリングが止まり、値は保たれる', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 'main';
    };
    const { lastFrame, rerender, unmount } = render(<Probe load={load} intervalMs={10} />);
    await tick();
    expect(lastFrame()).toContain('[main]');
    rerender(<Probe intervalMs={10} />);
    const paused = calls;
    await tick();
    expect(calls).toBe(paused); // 止まっている
    expect(lastFrame()).toContain('[main]'); // 表示は消えない
    rerender(<Probe load={load} intervalMs={10} />);
    await tick();
    expect(calls).toBeGreaterThan(paused); // 戻したら読み直す
    unmount();
  });

  it('アンマウント後はポーリングしない（タイマーを残さない）', async () => {
    let calls = 0;
    const { unmount } = render(
      <Probe
        load={async () => {
          calls += 1;
          return 'main';
        }}
        intervalMs={10}
      />,
    );
    await tick();
    unmount();
    const after = calls;
    await tick();
    expect(calls).toBe(after);
  });

  // 描画ごとに identity が変わる arrow を渡されても effect を張り替えない（= 再描画ごとに
  // git を呼ばない）ことの担保。ポーリング間隔は十分長くして、追加の呼び出しが
  // 「張り替えによるもの」だけになるようにする。
  it('取得関数の identity が変わっても effect を張り替えない', async () => {
    let calls = 0;
    const make = () => async () => {
      calls += 1;
      return 'main';
    };
    const { rerender, unmount } = render(<Probe load={make()} intervalMs={10_000} />);
    await tick();
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) {
      rerender(<Probe load={make()} intervalMs={10_000} />);
    }
    await tick();
    expect(calls).toBe(1);
    unmount();
  });
});
