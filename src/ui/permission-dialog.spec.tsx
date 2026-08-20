import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '@/core/i18n';
import type { PermissionRequest } from '@/core/types';
import { PermissionDialog } from '@/ui/permission-dialog';

const flush = () => new Promise((r) => setTimeout(r, 30));
const noop = () => {};

function question(multiSelect = false): PermissionRequest {
  return {
    id: 'q1',
    toolName: 'AskUserQuestion',
    input: {},
    kind: 'question',
    questions: [
      {
        question: 'Which language?',
        header: 'Lang',
        multiSelect,
        options: [
          { label: 'English', description: 'en' },
          { label: 'Japanese', description: 'ja' },
        ],
      },
    ],
  };
}

/**
 * 端末幅（ink-testing-library は 100 桁）より長いラベル・説明を持つ質問。
 * 文字を `X` / `Y` で埋めるので、フレーム内の出現数で「1 文字も欠けていない」ことを
 * 数えられる（折返し位置に依存しない検証）。
 */
function longQuestion(labelCells: number, descriptionCells: number): PermissionRequest {
  return {
    id: 'q1',
    toolName: 'AskUserQuestion',
    input: {},
    kind: 'question',
    questions: [
      {
        question: 'Which one?',
        header: 'Long',
        multiSelect: false,
        options: [
          { label: 'X'.repeat(labelCells), description: 'Y'.repeat(descriptionCells) },
          { label: 'short', description: 'also short' },
        ],
      },
    ],
  };
}

const countOf = (frame: string, char: string) => frame.split(char).length - 1;

// SGR（色）エスケープを落とす。正規表現に生の制御文字を書かない（biome）ため
// `tests/helpers.ts` と同じく charCode から組む。
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
/** フレームの 1 行から色と枠線を落として「枠の中身」だけにする。 */
const inner = (line: string) => line.replace(SGR, '').replace(/│/g, '').trimEnd();

describe('PermissionDialog — question', () => {
  it('renders the question and options', () => {
    const { lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    expect(lastFrame()).toContain('Which language?');
    expect(lastFrame()).toContain('English');
    expect(lastFrame()).toContain('Japanese');
  });

  // 回帰: ラベルと説明を横に並べていたときは Yoga が両方を縮め、長い文言が
  // 途中で切れて読めなくなっていた（実機で報告された不具合）。折返して全文出す。
  it('wraps long labels and descriptions instead of truncating them', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={longQuestion(150, 260)}
        onAnswer={noop}
        onAllow={noop}
        onDeny={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(countOf(frame, 'X')).toBe(150);
    expect(countOf(frame, 'Y')).toBe(260);
    // 折返した行は枠の内側に収まる（端末幅 100 桁を超える行を作らない）。
    for (const line of frame.split('\n')) {
      expect(line.replace(SGR, '').length).toBeLessThanOrEqual(100);
    }
  });

  it('keeps the description on its own line under the label', () => {
    const { lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    // ANSI と枠線を落として「枠の中身」だけを見る。
    const lines = (lastFrame() ?? '').split('\n').map(inner);
    const label = lines.findIndex((l) => l.includes('English'));
    expect(label).toBeGreaterThan(0);
    // ラベル行に説明は混ざらず、直後の行に字下げして出る。
    expect(lines[label]?.trim()).toBe('❯ English');
    expect(lines[label + 1]?.trim()).toBe('en');
    expect(lines[label + 1]?.startsWith('     ')).toBe(true);
  });

  it('selects the highlighted option on Enter and answers by question text', async () => {
    const onAnswer = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    stdin.write('[B'); // down arrow → Japanese
    await flush();
    stdin.write('\r'); // Enter
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'Japanese' });
  });

  it('always offers a free-text and a skip-to-chat option after the real ones', () => {
    const { lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    // ja catalog strings (the test env resolves to Japanese).
    expect(lastFrame()).toContain('自分で入力する');
    expect(lastFrame()).toContain('これについて相談する');
  });

  it('"Chat about this" skips the question and denies the tool (returns to chat)', async () => {
    const onAnswer = vi.fn();
    const onDeny = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={onDeny} />,
    );
    // English → Japanese → 自分で入力する → これについて相談する
    stdin.write('\x1B[B');
    await flush();
    stdin.write('\x1B[B');
    await flush();
    stdin.write('\x1B[B');
    await flush();
    stdin.write('\r');
    await flush();
    expect(onDeny).toHaveBeenCalledWith(expect.stringContaining('相談'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('"Type something." lets the user answer with free-form text', async () => {
    const onAnswer = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    stdin.write('\x1B[B'); // Japanese
    await flush();
    stdin.write('\x1B[B'); // 自分で入力する
    await flush();
    stdin.write('\r'); // enter typing mode
    await flush();
    stdin.write('my own answer');
    await flush();
    stdin.write('\r'); // submit
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'my own answer' });
  });

  /**
   * 自由記述欄は共通コンポーザ（`useComposer`）なので、一覧・詳細の入力欄と**同じ仕様**に
   * なる。以前はここだけ「Enter は必ず送信」で改行が打てなかった。
   */
  describe('自由記述欄は通常の入力欄と同じ仕様', () => {
    /** 「自分で入力する」を選んで typing モードに入る。 */
    const enterTyping = async (stdin: { write: (s: string) => void }) => {
      stdin.write('\x1B[B'); // Japanese
      await flush();
      stdin.write('\x1B[B'); // 自分で入力する
      await flush();
      stdin.write('\r'); // enter typing mode
      await flush();
    };

    // modifyOtherKeys（`[27;2;13~`）と CSI-u（`[13;2u`）の両方の端末を想定する。
    it.each([
      ['modifyOtherKeys', '\x1b[27;2;13~'],
      ['CSI-u', '\x1b[13;2u'],
    ])('Shift+Enter (%s) で改行し、Enter で複数行のまま送信する', async (_name, chord) => {
      const onAnswer = vi.fn();
      const { stdin } = render(
        <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
      );
      await enterTyping(stdin);
      stdin.write('one');
      await flush();
      stdin.write(chord);
      await flush();
      stdin.write('two');
      await flush();
      stdin.write('\r'); // submit
      await flush();
      expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'one\ntwo' });
    });

    // 端末が Shift+Enter を素の `\r` で送ってくる場合の保険（他の入力欄と同じ）。
    it('末尾バックスラッシュ + Enter でも改行になる', async () => {
      const onAnswer = vi.fn();
      const { stdin } = render(
        <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
      );
      await enterTyping(stdin);
      stdin.write('one\\');
      await flush();
      stdin.write('\r'); // → 改行（送信しない）
      await flush();
      stdin.write('two');
      await flush();
      stdin.write('\r');
      await flush();
      expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'one\ntwo' });
    });

    it('↑↓ が表示行のキャレット移動になる（以前は無反応だった）', async () => {
      const onAnswer = vi.fn();
      const { stdin } = render(
        <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
      );
      await enterTyping(stdin);
      stdin.write('ab');
      await flush();
      stdin.write('\x1B[A'); // ↑ = 最上段なのでバッファ先頭へ
      await flush();
      stdin.write('X');
      await flush();
      stdin.write('\r');
      await flush();
      expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'Xab' });
    });

    it('ドラッグで範囲選択し、離した時点でクリップボードへコピーする', async () => {
      const copied: string[] = [];
      const { stdin, lastFrame } = render(
        <PermissionDialog
          request={question()}
          onAnswer={noop}
          onAllow={noop}
          onDeny={noop}
          onCopy={(t) => copied.push(t)}
        />,
      );
      await enterTyping(stdin);
      stdin.write('hello world');
      await flush();
      // 描かれた行から実際の位置を割り出す（枠 + padding があるので端末幅からは求まらない）。
      const rows = (lastFrame() ?? '').split('\n').map((l) => l.replace(SGR, ''));
      const row = rows.findIndex((l) => l.includes('hello world'));
      expect(row).toBeGreaterThan(0);
      const from = (rows[row] ?? '').indexOf('world');
      const to = from + 'world'.length;
      stdin.write(`\x1b[<0;${from + 1};${row + 1}M`); // press
      await flush();
      stdin.write(`\x1b[<32;${to + 1};${row + 1}M`); // drag（motion bit 32）
      await flush();
      stdin.write(`\x1b[<0;${to + 1};${row + 1}m`); // release → 1 回だけコピー
      await flush();
      expect(copied).toEqual(['world']);
    });

    /**
     * press と release のあいだにキーが挟まると、保留していた press 位置が生き残って
     * release でキャレットを引き戻していた（打った文字の後ろにいたキャレットが飛ぶ）。
     * キー入力時に保留を捨てることで防ぐ。
     */
    it('押したまま打って離しても、キャレットが押した位置へ戻らない', async () => {
      const onAnswer = vi.fn();
      const { stdin, lastFrame } = render(
        <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
      );
      await enterTyping(stdin);
      stdin.write('abcd');
      await flush();
      const rows = (lastFrame() ?? '').split('\n').map((l) => l.replace(SGR, ''));
      const row = rows.findIndex((l) => l.includes('abcd'));
      const col = (rows[row] ?? '').indexOf('abcd');
      stdin.write(`\x1b[<0;${col + 1};${row + 1}M`); // 'a' の上で press（まだ動かさない）
      await flush();
      stdin.write('Z'); // 押したまま打つ → キャレットは末尾のまま
      await flush();
      stdin.write(`\x1b[<0;${col + 1};${row + 1}m`); // release（保留は捨てられている）
      await flush();
      stdin.write('!');
      await flush();
      stdin.write('\r');
      await flush();
      expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'abcdZ!' });
    });
  });

  /**
   * 詳細ビューはログの範囲選択のためマウス捕捉を保つようになった。モーダルは自分の
   * `useInput` を持ち背後の view のガードでは守られないので、レポート列（`[<0;10;5M`）を
   * 弾かないと自由記述の回答に混入する（クリックしただけで回答が汚れる）。
   */
  it('マウスレポートを回答テキストとして挿入しない', async () => {
    const onAnswer = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    stdin.write('\x1B[B'); // Japanese
    await flush();
    stdin.write('\x1B[B'); // 自分で入力する
    await flush();
    stdin.write('\r'); // enter typing mode
    await flush();
    stdin.write('ok');
    await flush();
    // 選択肢の行ではない場所（見出し = 枠の中の 2 行目）を押す。選択肢の上を押すと
    // 「その選択肢を選ぶ」操作になるので、ここでは混入だけを見るために外す。
    stdin.write('\x1b[<0;10;2M'); // press / drag / wheel はどれも文字ではない
    await flush();
    stdin.write('\x1b[<64;10;2M');
    await flush();
    stdin.write('\x1b[<0;10;2m');
    await flush();
    stdin.write('\r'); // submit
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'ok' });
  });

  it('returns from free-text back to the choices on Backspace when empty', async () => {
    const onAnswer = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    stdin.write('\x1B[B'); // Japanese
    await flush();
    stdin.write('\x1B[B'); // 自分で入力する
    await flush();
    stdin.write('\r'); // enter typing mode
    await flush();
    stdin.write('\x7f'); // Backspace on empty buffer → back to choices
    await flush();
    // Back in select mode: up moves to Japanese and Enter picks it (not free-text).
    stdin.write('\x1B[A'); // up → Japanese
    await flush();
    stdin.write('\r');
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'Japanese' });
  });

  it('shows a checkbox per option and a movable cursor in multi-select mode', async () => {
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question(true)} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    // 実選択肢はチェックボックス付き、カーソルは先頭（English）に見える。
    expect(lastFrame()).toContain('❯ [ ] English');
    expect(lastFrame()).toContain('[ ] Japanese');
    stdin.write(' '); // toggle English → [x]
    await flush();
    expect(lastFrame()).toContain('❯ [x] English');
    stdin.write('\x1B[B'); // down → カーソルが Japanese へ動くのが見える
    await flush();
    expect(lastFrame()).toContain('[x] English');
    expect(lastFrame()).toContain('❯ [ ] Japanese');
  });

  it('toggles options with space in multi-select mode', async () => {
    const onAnswer = vi.fn();
    const { stdin } = render(
      <PermissionDialog
        request={question(true)}
        onAnswer={onAnswer}
        onAllow={noop}
        onDeny={noop}
      />,
    );
    stdin.write(' '); // toggle English
    await flush();
    stdin.write('[B'); // down → Japanese
    await flush();
    stdin.write(' '); // toggle Japanese
    await flush();
    stdin.write('\r');
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'English, Japanese' });
  });

  // Ghostty/xterm など modifyOtherKeys / CSI-u を送る端末では、Space が生の
  // エスケープ列（`ESC [ 27 ; 1 ; 32 ~` / `ESC [ 32 u`）で届く。Ink はこれを
  // 素の ' ' に解釈しないため、正規化しないとトグルできない（実機で再現した不具合）。
  it('toggles with a modifyOtherKeys-encoded space', async () => {
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question(true)} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    stdin.write('\x1b[27;1;32~'); // modifyOtherKeys space → toggle English
    await flush();
    expect(lastFrame()).toContain('❯ [x] English');
  });

  // 日本語 IME がオンのあいだ、素の Space は**全角スペース（U+3000）**として届く
  // （macOS のかな入力の既定）。半角だけを見ていると Shift+Space でしかチェックが
  // 付けられない = 日本語で作業している間ずっと押しにくい（実機で再現した不具合）。
  it('全角スペース（IME オンの Space）でもトグルできる', async () => {
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question(true)} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    stdin.write('　'); // U+3000 → toggle English
    await flush();
    expect(lastFrame()).toContain('❯ [x] English');
  });

  /**
   * `active={false}`（一覧の list ゾーン）では表示だけ。ここでキーを取ると、一覧の
   * ↑↓ が選択肢移動に食われて**セッションを切り替えられない**（元の不具合）。
   */
  it('active=false では表示だけでキーを受け取らない', async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog
        request={question()}
        onAnswer={onAnswer}
        onAllow={noop}
        onDeny={noop}
        active={false}
      />,
    );
    await flush();
    // 質問文と選択肢は読める（一覧を眺めながら内容を確認できる）。
    expect(lastFrame()).toContain('Which language?');
    // ↑↓ でカーソルは動かず、Enter でも回答しない。
    stdin.write('\x1B[B');
    await flush();
    expect(lastFrame()).toContain('❯ English');
    stdin.write('\r');
    await flush();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('toggles with a CSI-u-encoded space', async () => {
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question(true)} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    stdin.write('\x1b[32u'); // CSI-u space → toggle English
    await flush();
    expect(lastFrame()).toContain('❯ [x] English');
  });

  /**
   * クリックで選択肢を選べる（決定は Enter）。一覧の行をクリックすると選択が移り、
   * 開くのは Enter という関係と同じにしてある。行はフレームから実測して押すので、
   * レイアウト（枠・見出し・折返し）が変わってもテストが追従する。
   */
  const rowOf = (frame: string, text: string) =>
    frame.split('\n').findIndex((l) => l.includes(text));

  it('クリックした選択肢へカーソルが移り、Enter でそれが回答になる', async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    const row = rowOf(lastFrame() ?? '', 'Japanese');
    expect(row).toBeGreaterThan(0);
    stdin.write(`\x1b[<0;5;${row + 1}M`); // SGR press（行は 1 始まり）
    await flush();
    expect(lastFrame()).toContain('❯ Japanese');
    stdin.write('\r');
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'Japanese' });
  });

  it('説明の行をクリックしてもその選択肢が選ばれる', async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    // 'ja' は Japanese の説明行（ラベルの下）。1 件は複数行なので塊のどこでも選べる。
    const row = rowOf(lastFrame() ?? '', 'ja');
    stdin.write(`\x1b[<0;5;${row + 1}M`);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onAnswer).toHaveBeenCalledWith({ 'Which language?': 'Japanese' });
  });

  it('区切り線の下の「これについて相談する」もクリックで選べる', async () => {
    const onDeny = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={noop} onAllow={noop} onDeny={onDeny} />,
    );
    await flush();
    const row = rowOf(lastFrame() ?? '', messages.ja.permission.chatAboutThis);
    expect(row).toBeGreaterThan(0);
    stdin.write(`\x1b[<0;5;${row + 1}M`);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onDeny).toHaveBeenCalledWith(messages.ja.permission.chatMessage);
  });

  /**
   * `active={false}`（一覧の list ゾーン）でも**マウスは受け取る**。クリックは
   * 「このダイアログを操作したい」という宣言なので、キーを持っていない状態でこそ必要
   * （一覧の行をクリックすると選択が移るのと同じ関係）。
   */
  it('active=false でもクリックで onActivate が呼ばれ、カーソルも動く', async () => {
    const onActivate = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog
        request={question()}
        onAnswer={noop}
        onAllow={noop}
        onDeny={noop}
        active={false}
        onActivate={onActivate}
      />,
    );
    await flush();
    const row = rowOf(lastFrame() ?? '', 'Japanese');
    stdin.write(`\x1b[<0;5;${row + 1}M`);
    await flush();
    expect(onActivate).toHaveBeenCalled();
    expect(lastFrame()).toContain('❯ Japanese');
  });

  it('枠の外のクリックでは onActivate を呼ばない', async () => {
    const onActivate = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog
        request={question()}
        onAnswer={noop}
        onAllow={noop}
        onDeny={noop}
        active={false}
        onActivate={onActivate}
      />,
    );
    await flush();
    const below = (lastFrame() ?? '').split('\n').length + 2; // 枠より下（1 始まり）
    stdin.write(`\x1b[<0;5;${below}M`);
    await flush();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('クリックしても自由記述の書きかけは消えない（選択へ戻って入力へ戻せる）', async () => {
    const onAnswer = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={onAnswer} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    // 「自分で入力する」へ移って書き始める。
    const typeRow = rowOf(lastFrame() ?? '', messages.ja.permission.typeSomething);
    stdin.write(`\x1b[<0;5;${typeRow + 1}M`);
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('書きかけ');
    await flush();
    // 選択肢をクリック → 選択モードへ戻る（書きかけは保持）。
    const row = rowOf(lastFrame() ?? '', 'English');
    stdin.write(`\x1b[<0;5;${row + 1}M`);
    await flush();
    expect(lastFrame()).toContain('❯ English');
    // もう一度「自分で入力する」へ戻ると、書きかけがそのまま残っている。
    const typeRow2 = rowOf(lastFrame() ?? '', messages.ja.permission.typeSomething);
    stdin.write(`\x1b[<0;5;${typeRow2 + 1}M`);
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame()).toContain('書きかけ');
  });
});

describe('PermissionDialog — tool', () => {
  const toolReq: PermissionRequest = {
    id: 't1',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    kind: 'tool',
  };

  it('allows on y', async () => {
    const onAllow = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={toolReq} onAnswer={noop} onAllow={onAllow} onDeny={noop} />,
    );
    stdin.write('y');
    await flush();
    expect(onAllow).toHaveBeenCalled();
  });

  it('denies on n with a message', async () => {
    const onDeny = vi.fn();
    const { stdin } = render(
      <PermissionDialog request={toolReq} onAnswer={noop} onAllow={noop} onDeny={onDeny} />,
    );
    stdin.write('n');
    await flush();
    expect(onDeny).toHaveBeenCalledWith(expect.stringContaining('拒否'));
  });

  /**
   * 枠の中のクリックはフォーカスを寄せるだけ（`onActivate`）。**許可/拒否は確定しない** —
   * クリック 1 回で `rm -rf` を許可してしまうのは危険なので、決定は必ずキーで取る。
   */
  it('枠の中のクリックは onActivate だけを呼び、許可も拒否もしない', async () => {
    const onActivate = vi.fn();
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const { stdin, lastFrame } = render(
      <PermissionDialog
        request={toolReq}
        onAnswer={noop}
        onAllow={onAllow}
        onDeny={onDeny}
        active={false}
        onActivate={onActivate}
      />,
    );
    await flush();
    const row = (lastFrame() ?? '').split('\n').findIndex((l) => l.includes('Bash'));
    stdin.write(`\x1b[<0;5;${row + 1}M`);
    await flush();
    expect(onActivate).toHaveBeenCalled();
    expect(onAllow).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });
});
