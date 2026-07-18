import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createTitleGenerator, type TitleQuery } from '@/utils/title';

/** A fake query() yielding a fixed message stream, capturing the request. */
function fakeQuery(messages: SDKMessage[]): {
  fn: TitleQuery;
  seen: { prompt?: string; model?: string; cwd?: string };
} {
  const seen: { prompt?: string; model?: string; cwd?: string } = {};
  const fn: TitleQuery = ({ prompt, options }) => {
    seen.prompt = prompt;
    seen.model = options.model;
    seen.cwd = options.cwd;
    return (async function* () {
      for (const m of messages) {
        yield m;
      }
    })();
  };
  return { fn, seen };
}

const result = (text: string): SDKMessage =>
  ({ type: 'result', subtype: 'success', result: text }) as unknown as SDKMessage;

describe('createTitleGenerator', () => {
  it('returns the trimmed result text from a successful turn', async () => {
    const { fn, seen } = fakeQuery([result('  Add OAuth login  ')]);
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    expect(await generate('implement oauth login please')).toBe('Add OAuth login');
    // Uses Haiku, runs in the given cwd, and includes the prompt in the request.
    expect(seen.model).toBe('claude-haiku-4-5');
    expect(seen.cwd).toBe('/repo');
    expect(seen.prompt).toContain('implement oauth login please');
  });

  it('returns null when the model produces no result text', async () => {
    const { fn } = fakeQuery([]);
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    expect(await generate('do something')).toBeNull();
  });

  it('returns null when the result is empty/whitespace', async () => {
    const { fn } = fakeQuery([result('   ')]);
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    expect(await generate('do something')).toBeNull();
  });

  it('never throws — returns null when the query errors', async () => {
    const fn: TitleQuery = () => {
      throw new Error('spawn failed');
    };
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    await expect(generate('do something')).resolves.toBeNull();
  });

  it('returns null when the stream errors mid-iteration', async () => {
    const fn: TitleQuery = () => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<SDKMessage>> => Promise.reject(new Error('stream died')),
      }),
    });
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    await expect(generate('do something')).resolves.toBeNull();
  });

  it('passes an abortController so the call is time-bounded', async () => {
    const seen: { hasAbort?: boolean } = {};
    const fn: TitleQuery = ({ options }) => {
      seen.hasAbort = options.abortController instanceof AbortController;
      return (async function* () {
        yield result('Title');
      })();
    };
    const generate = createTitleGenerator(fn, { cwd: '/repo' });
    await generate('x');
    expect(seen.hasAbort).toBe(true);
  });
});
