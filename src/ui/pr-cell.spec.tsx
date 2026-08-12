import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { PrCell } from './pr-cell';
import { glyph } from './theme';

// 制御文字を正規表現リテラルに直接書くと Biome の noControlCharactersInRegex に触れるので組み立てる。
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** The rendered cell without color escapes (the glyph/number is what's asserted). */
function cell(props: Parameters<typeof PrCell>[0]): string {
  const { lastFrame } = render(<PrCell {...props} />);
  return (lastFrame() ?? '').replace(SGR, '').trim();
}

describe('PrCell', () => {
  it('shows the number with the status glyph once both halves are known', () => {
    expect(cell({ pr: { number: 42, url: 'u' }, status: { mergeStatus: 'merged' } })).toBe(
      `${glyph.merged} #42`,
    );
  });

  it('shows the lookup mark alone when even the number is unknown', () => {
    expect(cell({ lookup: 'loading' })).toBe(glyph.prLoading);
    expect(cell({ lookup: 'error' })).toBe(glyph.prUnknown);
    expect(cell({})).toBe('');
  });

  // The regression: a number whose *status* never arrives used to render bare, which
  // reads exactly like a PR with nothing worth flagging.
  it('shows the lookup mark beside a known number while its status is missing', () => {
    expect(cell({ pr: { number: 42, url: 'u' }, lookup: 'loading' })).toBe(
      `${glyph.prLoading} #42`,
    );
    expect(cell({ pr: { number: 42, url: 'u' }, lookup: 'error' })).toBe(`${glyph.prUnknown} #42`);
  });

  it('prefers the real status glyph over the lookup mark', () => {
    expect(
      cell({ pr: { number: 42, url: 'u' }, status: { mergeStatus: 'mergeable' }, lookup: 'error' }),
    ).toBe(`${glyph.mergeable} #42`);
  });

  it("appends the count of the session's other PRs", () => {
    expect(cell({ pr: { number: 42, url: 'u' }, others: 2 })).toBe('#42 +2');
  });
});
