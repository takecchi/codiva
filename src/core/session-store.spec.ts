import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session-store';
import { initialState } from './status-reducer';
import type { CreateSessionInput, SessionState } from './types';

function state(id: string, overrides: Partial<SessionState> = {}): SessionState {
  const input: CreateSessionInput = {
    id,
    title: id,
    prompt: id,
    branch: `codiva/${id}`,
    worktreePath: `/tmp/${id}`,
    startedAt: 0,
  };
  return { ...initialState(input), ...overrides };
}

describe('SessionStore', () => {
  it('append adds sessions in order and exposes them via getSnapshot/ids', () => {
    const store = new SessionStore();
    store.append('1', state('1'));
    store.append('2', state('2'));
    expect(store.ids()).toEqual(['1', '2']);
    expect(store.getSnapshot().map((s) => s.id)).toEqual(['1', '2']);
    expect(store.get('1')?.id).toBe('1');
    expect(store.has('2')).toBe(true);
    expect(store.has('3')).toBe(false);
  });

  it('set replaces an existing state without reordering', () => {
    const store = new SessionStore();
    store.append('1', state('1'));
    store.append('2', state('2'));
    store.set('1', state('1', { status: 'running' }));
    expect(store.ids()).toEqual(['1', '2']);
    expect(store.get('1')?.status).toBe('running');
  });

  it('keeps object identity for unchanged rows across rebuilds', () => {
    const store = new SessionStore();
    store.append('1', state('1'));
    store.append('2', state('2'));
    const before = store.getSnapshot();
    store.set('2', state('2', { status: 'completed' }));
    const after = store.getSnapshot();
    expect(after).not.toBe(before); // new array
    expect(after[0]).toBe(before[0]); // untouched row keeps identity
    expect(after[1]).not.toBe(before[1]); // changed row is a new object
  });

  it('remove drops a session from order and state, keeping the rest', () => {
    const store = new SessionStore();
    store.append('1', state('1'));
    store.append('2', state('2'));
    store.append('3', state('3'));
    store.remove('2');
    expect(store.ids()).toEqual(['1', '3']);
    expect(store.getSnapshot().map((s) => s.id)).toEqual(['1', '3']);
    expect(store.has('2')).toBe(false);
    expect(store.get('2')).toBeUndefined();
  });

  it('remove is a no-op (no notify) for an unknown id', () => {
    const store = new SessionStore();
    store.append('1', state('1'));
    const listener = vi.fn();
    store.subscribe(listener);
    store.remove('nope');
    expect(store.ids()).toEqual(['1']);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const store = new SessionStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.append('1', state('1'));
    expect(listener).toHaveBeenCalledTimes(1);
    store.set('1', state('1', { status: 'running' }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    store.set('1', state('1', { status: 'completed' }));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clearListeners drops all subscribers', () => {
    const store = new SessionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearListeners();
    store.append('1', state('1'));
    expect(listener).not.toHaveBeenCalled();
  });
});
