import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnvRecord } from '@/core';

/** SDK には触らせない（`Options.env` に何が入るかだけを見る）。 */
const queryMock = vi.hoisted(() =>
  vi.fn((_params: { prompt: unknown; options?: { cwd?: string; env?: EnvRecord } }) => ({
    handle: true,
  })),
);
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { claudeQuery } = await import('./claude-query');

type Params = Parameters<typeof claudeQuery>[0];

describe('claudeQuery', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    queryMock.mockClear();
  });

  it('codiva が立てた NODE_ENV を落とした env で `claude` を起こす', () => {
    process.env.NODE_ENV = 'production';
    process.env.CODIVA_NODE_ENV_INJECTED = '1';
    claudeQuery({ prompt: 'hi', options: { cwd: '/repo' } } as Params);
    const options = queryMock.mock.calls[0]?.[0]?.options;
    // `Options.env` はマージされず丸ごと置き換えるので、他の変数は残っている必要がある。
    expect(options?.env?.NODE_ENV).toBeUndefined();
    expect(options?.env?.PATH).toBe(process.env.PATH);
    // 呼び出し側の options は保つ（env を足すだけ）。
    expect(options?.cwd).toBe('/repo');
  });

  it('ユーザーが渡した NODE_ENV はそのままエージェントへ渡す', () => {
    process.env.NODE_ENV = 'development';
    process.env.CODIVA_NODE_ENV_INJECTED = '';
    claudeQuery({ prompt: 'hi' } as Params);
    const options = queryMock.mock.calls[0]?.[0]?.options;
    expect(options?.env?.NODE_ENV).toBe('development');
  });
});
