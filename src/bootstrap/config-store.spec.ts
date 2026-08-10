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

describe('createConfigStore', () => {
  it('starts from the config read at startup', () => {
    const { store } = makeStore({ model: 'claude-opus-4-8' });
    expect(store.get()).toEqual({ model: 'claude-opus-4-8' });
  });

  it('merges each patch and saves the whole config', () => {
    const { store, saved } = makeStore({ model: 'claude-opus-4-8' });
    store.update({ autoPr: false });
    expect(store.get()).toEqual({ model: 'claude-opus-4-8', autoPr: false });
    expect(saved).toEqual([{ model: 'claude-opus-4-8', autoPr: false }]);
  });

  // 書き手が複数（/model・/agent・//config）あっても互いの変更を消さないことが
  // このストアの存在理由なので、順に書いて全部残ることを固定する。
  it('keeps changes from every writer', () => {
    const { store, saved } = makeStore({});
    store.update({ autoPr: false });
    store.update({ model: 'claude-sonnet-5' });
    store.update({ agent: 'codex' });
    expect(store.get()).toEqual({ autoPr: false, model: 'claude-sonnet-5', agent: 'codex' });
    expect(saved.at(-1)).toEqual({ autoPr: false, model: 'claude-sonnet-5', agent: 'codex' });
  });

  it('drops keys set to undefined (back to the default)', () => {
    const { store, saved } = makeStore({ model: 'claude-opus-4-8', autoPr: false });
    store.update({ model: undefined });
    expect(store.get()).toEqual({ autoPr: false });
    expect(saved.at(-1)).toEqual({ autoPr: false });
  });

  it('never throws when saving fails', () => {
    const store = createConfigStore({}, { save: async () => Promise.reject(new Error('nope')) });
    expect(() => store.update({ autoPr: false })).not.toThrow();
    expect(store.get()).toEqual({ autoPr: false });
  });
});
