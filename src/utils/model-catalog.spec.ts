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
