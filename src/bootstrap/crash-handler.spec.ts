import { describe, expect, it, vi } from 'vitest';
import { messages } from '@/core';
import { type CrashTarget, installCrashHandlers } from './crash-handler';

type Listener = (err: unknown) => void;

function fakeTarget(): {
  target: CrashTarget;
  emit: (event: string, err: unknown) => void;
  count: () => number;
} {
  const listeners = new Map<string, Listener[]>();
  return {
    target: {
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      off(event, listener) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== listener),
        );
      },
    },
    emit(event, err) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(err);
      }
    },
    count: () => [...listeners.values()].reduce((n, list) => n + list.length, 0),
  };
}

function setup(
  overrides: {
    write?: (report: string, at: number) => string | undefined;
    diagnostics?: () => readonly (readonly [string, string])[];
  } = {},
) {
  const order: string[] = [];
  const out: string[] = [];
  const exits: number[] = [];
  const fake = fakeTarget();
  const handlers = installCrashHandlers({
    messages: messages.ja,
    target: fake.target,
    now: () => 0,
    restore: () => order.push('restore'),
    flush: () => order.push('flush'),
    diagnostics: overrides.diagnostics,
    write:
      overrides.write ??
      ((report) => {
        order.push('write');
        out.push(report);
        return '/tmp/codiva/crash.log';
      }),
    stderr: {
      write: (text: string) => {
        order.push('stderr');
        out.push(text);
      },
    },
    exit: (code) => {
      order.push(`exit:${code}`);
      exits.push(code);
    },
  });
  return { handlers, fake, order, out, exits };
}

describe('installCrashHandlers', () => {
  it('uncaughtException で「端末復元 → flush → ログ → 表示 → exit(1)」の順に処理する', () => {
    const { fake, order } = setup();
    fake.emit('uncaughtException', new Error('boom'));
    expect(order).toEqual(['restore', 'flush', 'write', 'stderr', 'exit:1']);
  });

  it('レポートに種別・要約・スタックを含め、同じ内容を通常バッファへも出す', () => {
    const { fake, out } = setup();
    fake.emit('uncaughtException', new Error('boom'));
    const [report, printed] = out as [string, string];
    expect(report).toContain('kind: uncaughtException');
    expect(report).toContain('summary: boom');
    expect(report).toContain('Error: boom');
    expect(printed).toContain(messages.ja.crash.title);
    expect(printed).toContain(messages.ja.crash.log('/tmp/codiva/crash.log'));
    // 端末表示が壊れたときの復旧手段（--reset-terminal）を必ず案内する。
    expect(printed).toContain(messages.ja.crash.reset);
  });

  it('unhandledRejection も同じ経路で処理する（理由が Error でなくても落とさない）', () => {
    const { fake, out, exits } = setup();
    fake.emit('unhandledRejection', 'just a string');
    expect(exits).toEqual([1]);
    expect(out[0]).toContain('summary: just a string');
    expect(out[0]).toContain('(no stack trace)');
  });

  it('ログを書けなかったときは書けなかったことを表示する', () => {
    const { fake, out } = setup({ write: () => undefined });
    fake.emit('uncaughtException', new Error('boom'));
    expect(out[0]).toContain(messages.ja.crash.logFailed);
  });

  it('write が throw してもクラッシュ処理を続ける', () => {
    const { fake, order, exits } = setup({
      write: () => {
        throw new Error('disk full');
      },
    });
    fake.emit('uncaughtException', new Error('boom'));
    expect(order).toEqual(['restore', 'flush', 'stderr', 'exit:1']);
    expect(exits).toEqual([1]);
  });

  it('diagnostics が throw してもレポートは書く', () => {
    const { fake, out } = setup({
      diagnostics: () => {
        throw new Error('manager is gone');
      },
    });
    fake.emit('uncaughtException', new Error('boom'));
    expect(out[0]).toContain('summary: boom');
  });

  it('2 度目の例外では何もしない（多重発火で exit を重ねない）', () => {
    const { fake, order, exits } = setup();
    fake.emit('uncaughtException', new Error('boom'));
    fake.emit('uncaughtException', new Error('again'));
    expect(exits).toEqual([1]);
    expect(order).toEqual(['restore', 'flush', 'write', 'stderr', 'exit:1']);
  });

  it('クラッシュ時に自分のリスナを外す（ハンドラ内の例外で無限ループしない）', () => {
    const { fake } = setup();
    expect(fake.count()).toBe(2);
    fake.emit('uncaughtException', new Error('boom'));
    expect(fake.count()).toBe(0);
  });

  it('uninstall でリスナを外す（正常終了時）', () => {
    const { handlers, fake, order } = setup();
    handlers.uninstall();
    expect(fake.count()).toBe(0);
    fake.emit('uncaughtException', new Error('boom'));
    expect(order).toEqual([]);
  });

  it('record はログだけ残して終了しない（シグナルの記録用）', () => {
    const { handlers, order, out } = setup();
    const path = handlers.record('signal', 'terminated by SIGTERM');
    expect(path).toBe('/tmp/codiva/crash.log');
    expect(order).toEqual(['write']);
    expect(out[0]).toContain('kind: signal');
    expect(out[0]).toContain('summary: terminated by SIGTERM');
  });

  it('write が無ければファイルには残さない（crashLog: false）', () => {
    const order: string[] = [];
    const fake = fakeTarget();
    const stderrOut: string[] = [];
    const handlers = installCrashHandlers({
      messages: messages.en,
      target: fake.target,
      restore: () => order.push('restore'),
      stderr: { write: (text: string) => stderrOut.push(text) },
      exit: vi.fn(),
    });
    expect(handlers.record('signal', 'terminated by SIGHUP')).toBeUndefined();
    fake.emit('uncaughtException', new Error('boom'));
    expect(order).toEqual(['restore']);
    expect(stderrOut.join('')).toContain(messages.en.crash.logFailed);
  });
});
