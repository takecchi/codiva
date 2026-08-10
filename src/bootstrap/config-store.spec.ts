import { describe, expect, it } from 'vitest';
import type { CodivaConfig } from '@/core';
import { createConfigStore } from './config-store';

function makeStore(initial: CodivaConfig = {}) {
  const saved: CodivaConfig[] = [];
  const store = createConfigStore(initial, {
    save: async (config) => {
      saved.push(config);
    },
  });
  return { store, saved };
}

/** 完了を手で制御できる save（完了順の逆転を再現するため）。 */
function makeGatedStore(initial: CodivaConfig = {}) {
  const saved: CodivaConfig[] = [];
  const gates: Array<() => void> = [];
  const store = createConfigStore(initial, {
    save: (config) =>
      new Promise<void>((resolve) => {
        gates.push(() => {
          saved.push(config);
          resolve();
        });
      }),
  });
  return { store, saved, gates };
}

/** 保留中のマイクロタスク（save の catch → drain の再開）を消化する。 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createConfigStore', () => {
  it('starts from the config read at startup', () => {
    const { store } = makeStore({ model: 'claude-opus-4-8' });
    expect(store.get()).toEqual({ model: 'claude-opus-4-8' });
  });

  it('merges each patch and saves the whole config', async () => {
    const { store, saved } = makeStore({ model: 'claude-opus-4-8' });
    store.update({ autoPr: false });
    await store.flush();
    expect(store.get()).toEqual({ model: 'claude-opus-4-8', autoPr: false });
    expect(saved).toEqual([{ model: 'claude-opus-4-8', autoPr: false }]);
  });

  // 書き手が複数（/model・/agent・//config）あっても互いの変更を消さないことが
  // このストアの存在理由なので、順に書いて全部残ることを固定する。
  it('keeps changes from every writer', async () => {
    const { store, saved } = makeStore({});
    store.update({ autoPr: false });
    store.update({ model: 'claude-sonnet-5' });
    store.update({ agent: 'codex' });
    await store.flush();
    expect(store.get()).toEqual({ autoPr: false, model: 'claude-sonnet-5', agent: 'codex' });
    expect(saved.at(-1)).toEqual({ autoPr: false, model: 'claude-sonnet-5', agent: 'codex' });
  });

  it('drops keys set to undefined (back to the default)', async () => {
    const { store, saved } = makeStore({ model: 'claude-opus-4-8', autoPr: false });
    store.update({ model: undefined });
    await store.flush();
    expect(store.get()).toEqual({ autoPr: false });
    expect(saved.at(-1)).toEqual({ autoPr: false });
  });

  it('never throws when saving fails', async () => {
    const store = createConfigStore({}, { save: async () => Promise.reject(new Error('nope')) });
    expect(() => store.update({ autoPr: false })).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.get()).toEqual({ autoPr: false });
  });

  // issue #111: 並行に投げると完了順が入れ替わり、古いスナップショットが
  // 新しい設定を上書きする。書き込みは 1 本ずつ、待ちは最新へ畳む。
  it('never starts a second save while one is in flight', () => {
    const { store, gates } = makeGatedStore({});
    store.update({ language: 'ja' });
    store.update({ model: 'claude-sonnet-5' });
    store.update({ agent: 'codex' });
    expect(gates).toHaveLength(1);
  });

  it('coalesces updates made during a save into one latest write', async () => {
    const { store, saved, gates } = makeGatedStore({});
    store.update({ language: 'ja' }); // 保存開始（gates[0]）
    store.update({ model: 'claude-sonnet-5' }); // 書き込み待ちの間に来た更新
    store.update({ agent: 'codex' });

    gates[0]?.(); // 1 本目が着地 → 最新スナップショットで 2 本目が始まる
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]?.();
    await store.flush();

    // 中間状態は書かれず、最後に残るのは全部入りのスナップショット。
    expect(saved).toEqual([
      { language: 'ja' },
      { language: 'ja', model: 'claude-sonnet-5', agent: 'codex' },
    ]);
  });

  it('leaves the newest config on disk even when an earlier save settles last', async () => {
    const { store, saved, gates } = makeGatedStore({});
    store.update({ language: 'ja' });
    store.update({ model: 'claude-sonnet-5' });
    // 完了順を逆転させようとしても 2 本目はまだ始まっていない（直列化されている）。
    gates[1]?.();
    gates[0]?.();
    await tick();
    gates[1]?.();
    await store.flush();
    expect(saved.at(-1)).toEqual(store.get());
    expect(saved.at(-1)).toEqual({ language: 'ja', model: 'claude-sonnet-5' });
  });

  it('flush() resolves immediately when nothing is pending', async () => {
    const { store } = makeStore({});
    await expect(store.flush()).resolves.toBeUndefined();
  });
});
