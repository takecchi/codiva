import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '@/core/async-queue';

async function collect<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) {
    out.push(item);
  }
  return out;
}

describe('AsyncQueue', () => {
  it('yields buffered items pushed before iteration', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await collect(q)).toEqual([1, 2]);
  });

  it('delivers items pushed after a consumer is waiting', async () => {
    const q = new AsyncQueue<string>();
    const p = collect(q);
    q.push('a');
    q.push('b');
    q.close();
    expect(await p).toEqual(['a', 'b']);
  });

  it('ignores pushes after close', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2);
    expect(await collect(q)).toEqual([1]);
  });

  it('reports how many items are still buffered', async () => {
    const q = new AsyncQueue<string>();
    expect(q.pending).toBe(0);
    q.push('a');
    q.push('b');
    // 誰も取り出していないので 2 件残っている（切替後に拾い直す判断に使う）。
    expect(q.pending).toBe(2);
    const it0 = q[Symbol.asyncIterator]();
    await it0.next();
    expect(q.pending).toBe(1);
  });

  it('does not count an item handed straight to a waiting consumer', async () => {
    const q = new AsyncQueue<string>();
    const iter = q[Symbol.asyncIterator]();
    const next = iter.next();
    q.push('a'); // 待っている消費者へ直接渡るのでバッファには積まれない
    expect(q.pending).toBe(0);
    expect((await next).value).toBe('a');
  });
});
