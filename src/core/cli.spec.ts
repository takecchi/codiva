import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli';

describe('parseCliArgs', () => {
  it.each([
    [[], 'run'],
    [['--unknown'], 'run'],
    [['some', 'prompt'], 'run'],
    [['--reset-terminal'], 'reset-terminal'],
    [['--reset'], 'reset-terminal'],
    [['--unknown', '--reset-terminal'], 'reset-terminal'],
  ] as [string[], string][])('%o → %s', (argv, kind) => {
    expect(parseCliArgs(argv).kind).toBe(kind);
  });

  it('部分一致では反応しない（誤爆防止）', () => {
    expect(parseCliArgs(['--reset-terminals']).kind).toBe('run');
    expect(parseCliArgs(['reset-terminal']).kind).toBe('run');
  });
});
