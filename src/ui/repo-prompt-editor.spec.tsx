import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { RepoPromptEditor } from '@/ui/repo-prompt-editor';

const flush = () => new Promise((r) => setTimeout(r, 30));
const noop = () => {};
const ESC = '\x1b';
const ENTER = '\r';

describe('RepoPromptEditor', () => {
  it('renders the title, seeded content, and the key hint', () => {
    const { lastFrame } = render(
      <RepoPromptEditor initial="Open a PR when done" onSave={noop} onCancel={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('.codiva/prompt.md');
    expect(frame).toContain('Open a PR when done');
    expect(frame).toContain('Enter: 保存');
  });

  it('shows the placeholder when opened with no prompt', () => {
    const { lastFrame } = render(
      <RepoPromptEditor initial={undefined} onSave={noop} onCancel={noop} />,
    );
    expect(lastFrame() ?? '').toContain('作業が終わったら');
  });

  it('saves the seeded content on Enter (view → save)', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial="Open a PR when done" onSave={onSave} onCancel={noop} />,
    );
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('Open a PR when done');
  });

  it('appends typed text and saves it on Enter', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial={undefined} onSave={onSave} onCancel={noop} />,
    );
    stdin.write('run tests');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('run tests');
  });

  it('saves an empty string (clear) when Enter is pressed on an empty editor', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial={undefined} onSave={onSave} onCancel={noop} />,
    );
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('');
  });

  // INPUT と同じくドラッグで範囲選択してコピーできること（エディタは
  // `.codiva/prompt.md` のビューアも兼ねるので、読んで持ち出せる必要がある）。
  describe('mouse range selection', () => {
    /** SGR マウスレポート（フレーム上の 0 始まり座標 → レポートは 1 始まり）。 */
    const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
    const dragTo = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`;
    const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`;

    it('copies the dragged range once on release and keeps the text', async () => {
      const copied: string[] = [];
      const onSave = vi.fn();
      const { stdin, lastFrame } = render(
        <RepoPromptEditor
          initial="hello world"
          onSave={onSave}
          onCancel={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await flush();
      const lines = (lastFrame() ?? '').split('\n');
      const row = lines.findIndex((l) => l.includes('hello world'));
      const startCol = (lines[row] ?? '').indexOf('world');
      const endCol = startCol + 'world'.length;

      stdin.write(press(startCol, row));
      await flush();
      stdin.write(dragTo(endCol, row));
      await flush();
      stdin.write(release(endCol, row));
      await flush();

      expect(copied).toEqual(['world']);
      // 選択は文字を消さない。マウスレポートもテキストとして混入しない。
      expect(lastFrame() ?? '').toContain('hello world');
      expect(lastFrame() ?? '').not.toContain('[<0;');
      // 保存内容も変わらない（選択はバッファを書き換えない）。
      stdin.write(ENTER);
      await flush();
      expect(onSave).toHaveBeenCalledWith('hello world');
    });

    // Regression: 表示ウィンドウ（`visibleLineRange`）はキャレット行から決まるので、
    // press / drag でキャレットを動かすと INPUT_MAX_ROWS（8 行）を超える指示文では
    // その場で画面がスクロールし、「触っていない行」が選択・コピーされていた。
    it('selects what is on screen even when the prompt scrolls internally', async () => {
      const copied: string[] = [];
      const initial = Array.from({ length: 12 }, (_, i) => `line-${String(i).padStart(2, '0')}`);
      const { stdin, lastFrame } = render(
        <RepoPromptEditor
          initial={initial.join('\n')}
          onSave={noop}
          onCancel={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await flush();
      const lines = (lastFrame() ?? '').split('\n');
      // 末尾 8 行だけが見えている（キャレットは末尾）。その最上段からドラッグする。
      const topRow = lines.findIndex((l) => /line-\d\d/.test(l));
      const shownTop = /line-(\d\d)/.exec(lines[topRow] ?? '')?.[0] ?? '';
      const shownNext = /line-(\d\d)/.exec(lines[topRow + 1] ?? '')?.[0] ?? '';
      expect(shownTop).toBe('line-04');

      const startCol = (lines[topRow] ?? '').indexOf(shownTop);
      stdin.write(press(startCol, topRow));
      await flush();
      stdin.write(dragTo(startCol, topRow + 1));
      await flush();
      stdin.write(release(startCol, topRow + 1));
      await flush();

      // 見えている 1 行ぶん（次の行頭まで）が選択される。スクロールもしていない。
      expect(copied).toEqual([`${shownTop}\n`]);
      expect((lastFrame() ?? '').split('\n')[topRow]).toContain(shownTop);
      expect(shownNext).toBe('line-05');
    });

    it('a plain click copies nothing and moves the caret', async () => {
      const copied: string[] = [];
      const onSave = vi.fn();
      const { stdin, lastFrame } = render(
        <RepoPromptEditor
          initial="hello world"
          onSave={onSave}
          onCancel={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await flush();
      const lines = (lastFrame() ?? '').split('\n');
      const row = lines.findIndex((l) => l.includes('hello world'));
      const col = (lines[row] ?? '').indexOf('world');

      stdin.write(press(col, row));
      await flush();
      stdin.write(release(col, row));
      await flush();
      expect(copied).toEqual([]);

      // キャレットはクリック位置（'world' の直前）にあるので、そこへ挿入される。
      stdin.write('X');
      await flush();
      stdin.write(ENTER);
      await flush();
      expect(onSave).toHaveBeenCalledWith('hello Xworld');
    });

    it('ignores wheel reports (no text leaks, nothing is copied)', async () => {
      const copied: string[] = [];
      const { stdin, lastFrame } = render(
        <RepoPromptEditor
          initial="hello world"
          onSave={noop}
          onCancel={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await flush();
      stdin.write('\x1b[<64;5;5M'); // wheel up
      await flush();
      stdin.write('\x1b[<65;5;5M'); // wheel down
      await flush();
      expect(copied).toEqual([]);
      expect(lastFrame() ?? '').toContain('hello world');
      expect(lastFrame() ?? '').not.toContain('[<64;');
    });

    it('ignores a drag that starts outside the editor (the title row)', async () => {
      const copied: string[] = [];
      const { stdin, lastFrame } = render(
        <RepoPromptEditor
          initial="hello world"
          onSave={noop}
          onCancel={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await flush();
      const lines = (lastFrame() ?? '').split('\n');
      const titleRow = lines.findIndex((l) => l.includes('.codiva/prompt.md'));
      stdin.write(press(2, titleRow));
      await flush();
      stdin.write(dragTo(10, titleRow));
      await flush();
      stdin.write(release(10, titleRow));
      await flush();
      expect(copied).toEqual([]);
    });
  });

  it('cancels on Esc without saving', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial="keep me" onSave={onSave} onCancel={onCancel} />,
    );
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
