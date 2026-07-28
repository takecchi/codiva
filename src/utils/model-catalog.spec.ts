import { describe, expect, it, vi } from 'vitest';
import { type CatalogQuery, fetchModelCatalog } from './model-catalog';

/** Minimal fake of the `query` slice we use: only `supportedModels()` is read. */
function fakeQuery(
  supportedModels: () => Promise<unknown>,
  spy?: (params: Parameters<CatalogQuery>[0]) => void,
): CatalogQuery {
  return (params) => {
    spy?.(params);
    return {
      [Symbol.asyncIterator]: async function* () {
        // Never yields: catalog lookup completes on the init handshake alone.
      },
      supportedModels,
    };
  };
}

const SDK_ROWS = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
];

describe('fetchModelCatalog', () => {
  it('converts the SDK catalog into model options', async () => {
    const query = fakeQuery(async () => SDK_ROWS);
    await expect(fetchModelCatalog(query, { cwd: '/repo' })).resolves.toEqual([
      { value: 'default', displayName: 'Default (recommended)' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    ]);
  });

  it('passes the cwd and an abort controller through to the query', async () => {
    const spy = vi.fn();
    await fetchModelCatalog(
      fakeQuery(async () => SDK_ROWS, spy),
      { cwd: '/repo' },
    );
    const params = spy.mock.calls[0]?.[0];
    expect(params?.options.cwd).toBe('/repo');
    expect(params?.options.abortController).toBeInstanceOf(AbortController);
  });

  it('aborts the subprocess once the catalog is read (never leaves it resident)', async () => {
    const spy = vi.fn();
    await fetchModelCatalog(
      fakeQuery(async () => SDK_ROWS, spy),
      { cwd: '/repo' },
    );
    expect(spy.mock.calls[0]?.[0]?.options.abortController?.signal.aborted).toBe(true);
  });

  it('returns [] instead of throwing when the query fails', async () => {
    const query = fakeQuery(async () => {
      throw new Error('claude not found');
    });
    await expect(fetchModelCatalog(query, { cwd: '/repo' })).resolves.toEqual([]);
  });

  it('returns [] when the SDK reports an unexpected shape', async () => {
    const query = fakeQuery(async () => ({ models: 'nope' }));
    await expect(fetchModelCatalog(query, { cwd: '/repo' })).resolves.toEqual([]);
  });

  it('gives up and returns [] when the SDK never answers (self-contained timeout)', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      // Never resolves and never rejects — i.e. the SDK swallows the abort.
      const pending = fetchModelCatalog(
        fakeQuery(() => new Promise<unknown>(() => {}), spy),
        { cwd: '/repo' },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual([]);
      expect(spy.mock.calls[0]?.[0]?.options.abortController?.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops early when the caller aborts (shutdown during the startup fetch)', async () => {
    const shutdown = new AbortController();
    const spy = vi.fn();
    const pending = fetchModelCatalog(
      fakeQuery(
        () =>
          new Promise<unknown>((_resolve, reject) => {
            // Mirror the SDK: aborting the query rejects the pending init.
            const signal = spy.mock.calls[0]?.[0]?.options.abortController?.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        spy,
      ),
      { cwd: '/repo', signal: shutdown.signal },
    );
    shutdown.abort();
    await expect(pending).resolves.toEqual([]);
    expect(spy.mock.calls[0]?.[0]?.options.abortController?.signal.aborted).toBe(true);
  });

  it('aborts even when the query throws', async () => {
    const spy = vi.fn();
    await fetchModelCatalog(
      fakeQuery(async () => {
        throw new Error('boom');
      }, spy),
      { cwd: '/repo' },
    );
    expect(spy.mock.calls[0]?.[0]?.options.abortController?.signal.aborted).toBe(true);
  });
});
