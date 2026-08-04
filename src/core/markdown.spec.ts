import { describe, expect, it } from 'vitest';
import { type RichLine, renderMarkdown } from './markdown';

/** Flatten a rendered line to its plain text (styling dropped) for coarse asserts. */
function plain(line: RichLine | undefined): string {
  return (line ?? []).map((s) => s.text).join('');
}

/** Render, then map every logical line to its plain text. */
function plainLines(md: string): string[] {
  return renderMarkdown(md).map(plain);
}

describe('renderMarkdown — inline styling', () => {
  it('keeps plain prose as a single unstyled span', () => {
    const lines = renderMarkdown('just some text');
    expect(lines).toEqual([[{ text: 'just some text' }]]);
  });

  it('marks **strong** as bold', () => {
    const lines = renderMarkdown('a **b** c');
    expect(lines[0]).toEqual([{ text: 'a ' }, { text: 'b', bold: true }, { text: ' c' }]);
  });

  it('marks *emphasis* as italic', () => {
    const lines = renderMarkdown('a *b* c');
    expect(lines[0]).toEqual([{ text: 'a ' }, { text: 'b', italic: true }, { text: ' c' }]);
  });

  it('marks `code` with the code tone', () => {
    const lines = renderMarkdown('run `npm test` now');
    expect(lines[0]).toEqual([
      { text: 'run ' },
      { text: 'npm test', tone: 'code' },
      { text: ' now' },
    ]);
  });

  it('marks ~~del~~ as strikethrough', () => {
    const lines = renderMarkdown('a ~~b~~');
    expect(lines[0]).toEqual([{ text: 'a ' }, { text: 'b', strikethrough: true }]);
  });

  it('renders a link as underlined link-toned text, carrying the href', () => {
    const lines = renderMarkdown('see [docs](https://x.dev)');
    // href はスパンに載せる: 見えているのは label なので表示テキストから復元できない。
    expect(lines[0]).toEqual([
      { text: 'see ' },
      { text: 'docs', underline: true, tone: 'link', link: 'https://x.dev' },
    ]);
  });

  it('開けないスキームの href は載せない（クリックで開く対象にしない）', () => {
    expect(renderMarkdown('[mail](mailto:a@b.test)')[0]).toEqual([
      { text: 'mail', underline: true, tone: 'link', link: undefined },
    ]);
    expect(renderMarkdown('[rel](./docs/a.md)')[0]).toEqual([
      { text: 'rel', underline: true, tone: 'link', link: undefined },
    ]);
  });

  it('裸の URL は autolink されて href が付く', () => {
    expect(renderMarkdown('go https://x.dev/a now')[0]).toEqual([
      { text: 'go ' },
      { text: 'https://x.dev/a', underline: true, tone: 'link', link: 'https://x.dev/a' },
      { text: ' now' },
    ]);
  });

  it('nests inline styles (bold + code)', () => {
    const lines = renderMarkdown('**bold `code`**');
    expect(lines[0]).toEqual([
      { text: 'bold ', bold: true },
      { text: 'code', bold: true, tone: 'code' },
    ]);
  });

  it('does not corrupt literal ampersands / angle brackets', () => {
    expect(plainLines('a & b < c > d')).toEqual(['a & b < c > d']);
  });

  it('splits a hard line break (<br>) into two logical lines', () => {
    expect(plainLines('a  \nb')).toEqual(['a', 'b']);
  });

  it('renders an image as its underlined alt text', () => {
    const lines = renderMarkdown('![diagram](p.png)');
    expect(lines[0]).toEqual([{ text: 'diagram', underline: true, tone: 'link' }]);
  });
});

describe('renderMarkdown — robustness', () => {
  it('passes block-level HTML through as plain lines', () => {
    expect(plainLines('<div>hi</div>')).toEqual(['<div>hi</div>']);
  });

  it('returns no lines for empty / whitespace-only input', () => {
    expect(renderMarkdown('')).toEqual([]);
    expect(renderMarkdown('   \n  ')).toEqual([]);
  });
});

describe('renderMarkdown — block structure', () => {
  it('renders a heading bold with the heading tone', () => {
    expect(renderMarkdown('## Section')).toEqual([
      [{ text: 'Section', bold: true, tone: 'heading' }],
    ]);
  });

  it('separates paragraphs with a single blank line', () => {
    expect(plainLines('one\n\ntwo')).toEqual(['one', '', 'two']);
  });

  it('trims leading and trailing blank lines', () => {
    expect(plainLines('\n\nhi\n\n')).toEqual(['hi']);
  });

  it('prefixes unordered list items with a bullet marker', () => {
    const lines = renderMarkdown('- one\n- two');
    expect(plain(lines[0])).toBe('• one');
    expect(plain(lines[1])).toBe('• two');
    expect(lines[0]?.[0]).toEqual({ text: '• ', tone: 'marker' });
  });

  it('numbers ordered list items from the list start', () => {
    expect(plainLines('3. a\n4. b')).toEqual(['3. a', '4. b']);
  });

  it('renders task-list checkboxes', () => {
    expect(plainLines('- [x] done\n- [ ] todo')).toEqual(['• [x] done', '• [ ] todo']);
  });

  it('indents nested list items under their parent', () => {
    const lines = plainLines('- parent\n  - child');
    expect(lines[0]).toBe('• parent');
    expect(lines[1]).toBe('  • child');
  });

  it('renders fenced code blocks verbatim with the code tone, one line each', () => {
    const lines = renderMarkdown('```js\nconst x = 1;\nfoo();\n```');
    expect(lines).toEqual([
      [{ text: 'const x = 1;', tone: 'code', dim: true }],
      [{ text: 'foo();', tone: 'code', dim: true }],
    ]);
  });

  it('preserves indentation inside fenced code blocks', () => {
    const lines = renderMarkdown('```\n  indented\n```');
    expect(plain(lines[0])).toBe('  indented');
  });

  it('prefixes blockquote lines with a quote bar', () => {
    const lines = renderMarkdown('> quoted');
    expect(plain(lines[0])).toBe('│ quoted');
    expect(lines[0]?.[0]).toEqual({ text: '│ ', tone: 'quote' });
  });

  it('renders a thematic break as a rule line', () => {
    const lines = renderMarkdown('---');
    expect(lines[0]?.[0]?.tone).toBe('marker');
    expect(plain(lines[0]).length).toBeGreaterThan(0);
  });

  it('renders a table as header + rows joined by separators', () => {
    const lines = plainLines('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(lines[0]).toBe('A │ B');
    expect(lines[1]).toBe('1 │ 2');
  });
});
