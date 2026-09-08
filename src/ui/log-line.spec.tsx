import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { DisplayLine, LogKind } from '@/core';
import { LogLine } from './log-line';
import { logBackground } from './theme';

/**
 * 地の色そのもの（SGR）は検証できない — テストは非 TTY で走るので Ink は色を吐かない。
 * ここで守るのは「どの kind に地の色を持たせるか」という**意図**のほうで、増やすときに
 * この表を直す手が要るようにしてある（ログの行は縦にびっしり並ぶので、地の色を配りすぎると
 * どれも目立たなくなる = 印として機能しなくなる）。
 */
describe('logBackground', () => {
  it('地の色を持つのはユーザーの発言だけ', () => {
    expect(Object.keys(logBackground)).toEqual(['user']);
    expect(logBackground.user).toBeTruthy();
  });
});

describe('LogLine', () => {
  const KINDS: readonly LogKind[] = [
    'assistant_text',
    'tool_use',
    'tool_result',
    'result',
    'user',
    'system',
    'error',
  ];

  it.each(KINDS)('%s の行はテキストをそのまま描く', (kind) => {
    const line: DisplayLine = { key: '1:0', kind, text: 'hello' };
    expect(render(<LogLine line={line} />).lastFrame()).toContain('hello');
  });

  it('選択範囲が掛かっていてもテキストは欠けない（片に切り直して描くため）', () => {
    const line: DisplayLine = { key: '1:0', kind: 'user', text: '> hello' };
    expect(render(<LogLine line={line} sel={{ from: 2, to: 4 }} />).lastFrame()).toContain(
      '> hello',
    );
  });
});
