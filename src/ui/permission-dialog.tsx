import { Box, type DOMElement, Text, useInput, useWindowSize } from 'ink';
import { type FC, useRef, useState } from 'react';
import {
  type ChoiceRowItem,
  type ChoiceView,
  choiceIndexAtRow,
  choiceLines,
  choiceRowHeights,
  choiceView,
  DIALOG_CHOICE_MIN_ROWS,
  dialogContentWidth,
  type PermissionRequest,
  parseSgrMouse,
  wrapDisplayLines,
} from '@/core';
import { ChoiceRow } from './choice-row';
import { Composer, useComposer } from './composer';
import { useAbsolutePosition, useBoxHeight } from './hooks';
import { useMessages } from './i18n-context';
import { normalizeChord } from './input';
import { statusColor, theme } from './theme';

/**
 * Renders the pending decision a session is blocked on and captures the user's
 * response. Two shapes:
 *  - kind 'question' (AskUserQuestion): pick an option per question → onAnswer
 *  - kind 'tool': allow / deny a tool call → onAllow / onDeny
 * This owns the active key handler while a decision is pending **and** `active`
 * （既定 true）。一覧ビューは選択行の切替（↑↓）と両立させるため、`list` ゾーンでは
 * `active={false}` で「表示だけ」にする。無効化してもハンドラは**マウントしたまま**なので、
 * Tab で戻ってきたときに回答の途中経過（質問の何問目か・複数選択のチェック・自由記述の
 * 内容）が失われない。
 *
 * **`active={false}` でもマウスは受け取る**（キーだけを止める）。ダイアログのクリックは
 * 「ここへフォーカスを移す」操作（`onActivate`）なので、キーを持っていない状態でこそ
 * 必要になる — 一覧の行をクリックすると選択が移るのと同じ関係（ink-components.md）。
 */
export const PermissionDialog: FC<{
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onAllow: () => void;
  onDeny: (message: string) => void;
  /** 自由記述欄のマウス範囲選択をクリップボードへ（OSC 52）。合成ルートから注入。 */
  onCopy?: (text: string) => void;
  /** false ならキーを受け取らない（表示のみ）。省略時は true。 */
  active?: boolean;
  /**
   * ダイアログの中がクリックされた（= ここを操作したい）。一覧ビューはフォーカスゾーンを
   * `dialog` へ、詳細ビューは `log` ゾーンから `dialog` ゾーンへ戻す。
   */
  onActivate?: () => void;
  /**
   * `active={false}` のときに枠内へ出す案内。**ゾーンから抜ける／戻る方法は view 固有**
   * （一覧は「↑↓ でセッション切替」、詳細は「↑↓ でログを遡る」）なので、共有コンポーネントに
   * view の知識を持たせず文言を渡してもらう。省略時は一覧向けの既定。
   */
  inactiveHint?: string;
  /**
   * 枠を含めてダイアログが使ってよい縦幅（`core/layout.ts` の `dialogMaxRows`）。
   * 溢れる選択肢は内部スクロールへ押し出して、下のログ／セッション一覧の席を守る。
   * 省略すると全件描く（低い端末ではログの可視行が 0 になる）。
   */
  maxRows?: number;
}> = ({
  request,
  onAnswer,
  onAllow,
  onDeny,
  onCopy,
  active = true,
  onActivate,
  inactiveHint,
  maxRows,
}) => {
  if (request.kind === 'question') {
    return (
      <QuestionDialog
        request={request}
        onAnswer={onAnswer}
        onDeny={onDeny}
        onCopy={onCopy}
        active={active}
        onActivate={onActivate}
        inactiveHint={inactiveHint}
        maxRows={maxRows}
      />
    );
  }
  return (
    <ToolDialog
      request={request}
      onAllow={onAllow}
      onDeny={onDeny}
      active={active}
      onActivate={onActivate}
      inactiveHint={inactiveHint}
    />
  );
};

const ToolDialog: FC<{
  request: PermissionRequest;
  onAllow: () => void;
  onDeny: (message: string) => void;
  active: boolean;
  onActivate?: () => void;
  inactiveHint?: string;
}> = ({ request, onAllow, onDeny, active, onActivate, inactiveHint }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  // 枠の位置と高さを実測する（クリックがこのダイアログの中かを判定するため）。
  const boxRef = useRef<DOMElement>(null);
  const box = useAbsolutePosition(boxRef);
  const height = useBoxHeight(boxRef);

  useInput((rawInput, rawKey) => {
    // マウスレポートを先に解釈する。モーダルは自分の useInput を持つので背後の view の
    // 先取り解釈では守られず、クリック/ホイールの列が y/n 判定へ流れ込む（下の
    // QuestionDialog と同じ理由。`repo-prompt-editor` も同じ防御を持つ）。
    const mouse = parseSgrMouse(rawInput);
    if (mouse) {
      // 枠の中を押したら「ここを操作したい」= フォーカスを寄せる（y/n は押さない —
      // クリックで許可/拒否が確定するのは危険なので、決定は必ずキーで取る）。
      if (mouse.kind === 'press' && box && height !== undefined) {
        if (mouse.y >= box.top && mouse.y < box.top + height) {
          onActivate?.();
        }
      }
      return;
    }
    // キーを持っていないときは表示だけ（背後の view が一覧の操作に使う）。
    if (!active) {
      return;
    }
    // 一覧/詳細ビューと同じく chord を復号する。modifyOtherKeys / CSI-u を送る端末
    // （Ghostty など）では y/n も生のエスケープ列で届き、素の比較が外れるため。
    const { input } = normalizeChord(rawInput, rawKey);
    if (input === 'y' || input === 'Y') {
      onAllow();
    } else if (input === 'n' || input === 'N') {
      onDeny(m.permission.denied);
    }
  });

  // ツール入力の要約。何を許可するのか（実行されるコマンド等）は判断材料なので、
  // 1 行に切り詰めず本文幅で折返して出す（先頭 200 文字までなので数行で収まる）。
  const summary = JSON.stringify(request.input).slice(0, 200);
  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      // 操作を受け付けない間は枠を落として「今キーが効くのはここではない」ことを示す。
      borderColor={active ? statusColor.awaitingPermission : theme.dim}
      paddingX={1}
      flexShrink={0}
    >
      <Text color={statusColor.awaitingPermission} bold>
        {m.permission.toolTitle(request.toolName)}
      </Text>
      {/* prefix 無しの 1 件として `choiceLines` で折返す（表示幅ベースの折返しと
          安定キーをそのまま使う。選択肢と同じ経路にして挙動を揃える）。 */}
      {choiceLines({ label: summary }, dialogContentWidth(columns), '').map((line) => (
        <Text key={line.key} dimColor>
          {line.text}
        </Text>
      ))}
      {active ? (
        <Text>
          <Text color={theme.yes}>y</Text>: {m.permission.allow} ・ <Text color={theme.no}>n</Text>:{' '}
          {m.permission.deny}
        </Text>
      ) : (
        <Text dimColor>{inactiveHint ?? m.permission.inactiveHelp}</Text>
      )}
    </Box>
  );
};

/**
 * AskUserQuestion のダイアログ。実選択肢に加えて Claude Code に倣った 2 つの導線を
 * 必ず末尾に足す:
 *  - 「自分で入力する」(Type something.) — 選択肢ではなく自由記述で答える。選ぶと
 *    typing モードへ入り、入力テキストがその質問の回答になる。
 *  - 「これについて相談する」(Chat about this) — 区切り線の下に置き、質問をスキップ
 *    してツールを拒否し、通常の会話へ戻す（`onDeny`）。
 *
 * 自由記述欄は共通の {@link useComposer} を通すので、一覧・詳細のコンポーザと**完全に
 * 同じ仕様**になる（Shift+Enter で改行、↑↓ で表示行のキャレット移動、ドラッグで範囲選択
 * → コピー、クリックでキャレット移動）。ここだけ「Enter が必ず送信」だったのが以前の
 * 食い違いで、複数行の回答が書けなかった。
 *
 * 選択肢は**クリックでも選べる**（一覧の行クリックと同じ「選ぶだけ」で、決定は Enter）。
 * 当たり判定は実測した選択肢ブロックの上端 + 描画と同じ `choiceRowHeights` で逆算する
 * （1 件 = 1 行ではない: ラベルの折返しと説明の行があるため）。
 */
/**
 * 選択肢ブロック（実選択肢 + 「自分で入力する」）に使える行数。`maxRows` は枠を含む
 * ダイアログ全体の上限なので、**このコンポーネントが実際に描く**固定部分
 * （`otherRows`）を引いた残りが選択肢の予算になる。`CommandPalette` の `fitRows` と
 * 同じく、描画構造を知っているコンポーネント側に置く小さな純関数。
 *
 * 下限（{@link DIALOG_CHOICE_MIN_ROWS}）を割るときは上限より高くなることを許す
 * （`paletteMaxRows` の `PALETTE_MIN_ROWS` と同じ方針 — 予算より「カーソルの選択肢が
 * 見えること」を優先する）。
 */
function choiceCap(maxRows: number | undefined, otherRows: number): number | undefined {
  if (maxRows === undefined) {
    return undefined;
  }
  return Math.max(DIALOG_CHOICE_MIN_ROWS, maxRows - otherRows);
}

const QuestionDialog: FC<{
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onDeny: (message: string) => void;
  onCopy?: (text: string) => void;
  active: boolean;
  onActivate?: () => void;
  inactiveHint?: string;
  maxRows?: number;
}> = ({ request, onAnswer, onDeny, onCopy, active, onActivate, inactiveHint, maxRows }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  const questions = request.questions ?? [];
  const [qIndex, setQIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Set<string>>(new Set());
  // 'select' = カーソルで選択肢を選ぶ / 'typing' = 「自分で入力する」で自由記述中。
  const [mode, setMode] = useState<'select' | 'typing'>('select');
  const composer = useComposer({ onCopy });
  const bufferRef = composer.bufferRef;
  // 枠全体（クリックが「このダイアログの中」かの判定 = フォーカスを寄せる範囲）と、
  // 選択肢ブロック（実選択肢 + 「自分で入力する」）、区切り線の下の「相談する」。
  // クリックの当たり判定は**描画に使ったのと同じ幾何**（実測した上端 + 同じ折返し幅）で
  // 行う。位置を端末幅から見積もると枠・パディング・折返しのぶんズレる。
  const boxRef = useRef<DOMElement>(null);
  const box = useAbsolutePosition(boxRef);
  const boxHeight = useBoxHeight(boxRef);
  const mainRef = useRef<DOMElement>(null);
  const mainBox = useAbsolutePosition(mainRef);
  const mainHeight = useBoxHeight(mainRef);
  const chatRef = useRef<DOMElement>(null);
  const chatBox = useAbsolutePosition(chatRef);
  const chatHeight = useBoxHeight(chatRef);

  const current = questions[qIndex];
  // 実選択肢の後ろに「自分で入力する」(typeIndex) と「これについて相談する」(chatIndex)
  // を仮想的に並べる。カーソルは [0, chatIndex] を移動する。
  const optionCount = current?.options.length ?? 0;
  const typeIndex = optionCount;
  const chatIndex = optionCount + 1;

  // カーソル記号（typing 中はカーソル表示を出さない）。複数選択でもチェックボックスとは
  // 別にこのポインタを出す（`❯ [x] ラベル`）。ポインタが無いとカーソル位置が色でしか
  // 分からず、どの行にいるのか見えない＝「トグルできない」ように見えるため。
  const marker = (i: number) => (mode === 'select' && cursor === i ? '❯' : ' ');
  // 複数選択時はチェックボックス幅（"[x] "）ぶん、特別項目（自分で入力する/相談する）を
  // 字下げして実選択肢と桁を揃える。
  const pad = current?.multiSelect ? '    ' : '';
  // ラベル・説明の折返し幅（枠とパディングを引いた本文幅）。ラベルと説明を横に並べず
  // ここで折返すことで、長い文言でも切り捨てずに全文を出す。
  const width = dialogContentWidth(columns);

  // 描画とクリック当たり判定で回す**同じ配列**。prefix は表示幅ぶん折返し幅を食うので、
  // 行数（= 当たり判定）にも効く。
  const mainItems: ChoiceRowItem[] = [
    ...(current?.options ?? []).map((opt, i) => ({
      choice: { label: opt.label, description: opt.description },
      prefix: `${marker(i)} ${
        current?.multiSelect ? (multi.has(opt.label) ? '[x] ' : '[ ] ') : ''
      }`,
    })),
    { choice: { label: m.permission.typeSomething }, prefix: `${marker(typeIndex)} ${pad}` },
  ];
  const chatItem: ChoiceRowItem = {
    choice: { label: m.permission.chatAboutThis },
    prefix: `${marker(chatIndex)} ${pad}`,
  };
  const mainHeights = choiceRowHeights(mainItems, width);
  const chatHeights = choiceRowHeights([chatItem], width);

  // 操作ヒントは状態で変わる（表示のみ / 自由記述中 / 選択中）。文字列を先に決めて
  // 描画と高さの見積りで同じものを使う（折返して 2 行になる端末があるため）。
  const hintText = !active
    ? (inactiveHint ?? m.permission.inactiveHelp)
    : mode === 'typing'
      ? m.permission.typingHelp
      : m.permission.questionHelp(current?.multiSelect ?? false);

  /*
   * 選択肢ブロックの予算 = ダイアログの上限 - 固定部分。固定部分は**下の JSX が実際に
   * 描く行**と 1 対 1 で対応させる（食い違うと上限を超えてログの席を奪う / 逆に余らせる）:
   *   枠線 2 + 見出し 1 + 質問文（折返し n）+ 選択肢ブロックの上余白 1
   *   + 自由記述中なら（上余白 1 + 入力欄）
   *   + 区切りブロック（上余白 1 + 区切り線 1 + 「相談する」n）
   *   + ヒント（上余白 1 + 折返し n）
   */
  const questionRows = current ? wrapDisplayLines(current.question, width).length : 1;
  const chatRows = chatHeights[0] ?? 1;
  const otherRows =
    2 +
    1 +
    questionRows +
    1 +
    // 入力欄は自分が描く行数を知っている（罫線 + 内部スクロールの窓）。
    (mode === 'typing' ? 1 + composer.drawnRows : 0) +
    (1 + 1 + chatRows) +
    (1 + wrapDisplayLines(hintText, width).length);
  const cap = choiceCap(maxRows, otherRows);
  // 上限に収まらないぶんは内部スクロール（カーソルの件が必ず見える）。上限なしなら全件。
  const view: ChoiceView =
    cap === undefined
      ? {
          start: 0,
          end: mainItems.length,
          hiddenAbove: 0,
          hiddenBelow: 0,
          showAbove: false,
          showBelow: false,
        }
      : choiceView(mainHeights, cursor, cap);
  const visibleItems = mainItems.slice(view.start, view.end);
  const visibleHeights = mainHeights.slice(view.start, view.end);

  /**
   * クリックした行の選択肢 index（`chatIndex` を含む）。ブロックの外・未実測・縦に潰れて
   * いるときは undefined = 判定しない（黙って別の選択肢を選ぶより効かないほうがよい。
   * ヘッダ・コンポーザと同じ方針）。
   */
  const choiceAtRow = (y: number): number | undefined => {
    // 判定は**描いたウィンドウ**で行う（隠れている件を数えない）。上端のインジケータは
    // 1 行を占めるので、その分だけ選択肢の 1 行目がずれる。
    const mainRows =
      visibleHeights.reduce((sum, rows) => sum + rows, 0) +
      (view.showAbove ? 1 : 0) +
      (view.showBelow ? 1 : 0);
    if (mainBox && !(mainHeight !== undefined && mainHeight < mainRows)) {
      const hit = choiceIndexAtRow(visibleHeights, y - mainBox.top - (view.showAbove ? 1 : 0));
      if (hit !== undefined) {
        return view.start + hit;
      }
    }
    // 「相談する」のブロックは 1 行目が区切り線なので、その 1 行ぶんずらして数える。
    const chatRows = (chatHeights[0] ?? 0) + 1;
    if (chatBox && !(chatHeight !== undefined && chatHeight < chatRows)) {
      if (choiceIndexAtRow(chatHeights, y - chatBox.top - 1) !== undefined) {
        return chatIndex;
      }
    }
    return undefined;
  };

  /** クリックがこのダイアログの枠の中か（= キーをここへ寄せてよいか）。 */
  const insideDialog = (y: number): boolean =>
    box !== undefined && boxHeight !== undefined && y >= box.top && y < box.top + boxHeight;

  // 質問への回答を確定し、次の質問へ進む（最後なら全回答を返す）。選択肢・自由記述で共通。
  const submit = (chosen: string) => {
    if (!current) {
      return;
    }
    const nextAnswers = { ...answers, [current.question]: chosen };
    if (qIndex < questions.length - 1) {
      setAnswers(nextAnswers);
      setQIndex(qIndex + 1);
      setCursor(0);
      setMulti(new Set());
      setMode('select');
      composer.reset();
    } else {
      onAnswer(nextAnswers);
    }
  };

  useInput(
    (rawInput, rawKey) => {
      if (!current) {
        return;
      }
      // マウスレポートは文字入力として扱わない。自由記述モード（`typing`）はテキスト編集に
      // 流すので、これが無いとログをクリック/ドラッグした瞬間に `[<0;10;5M` のような
      // レポート列が回答へ挿入される（詳細ビューがマウス捕捉を保つようになったため実際に
      // 起きる。モーダルは背後の view のガードでは守られない）。
      // 自由記述中は他のコンポーザと同じく press/drag/release を範囲選択・キャレット移動に
      // 使う（扱えなかったレポートもここで捨てる = 生テキストとして漏らさない）。
      const mouse = parseSgrMouse(rawInput);
      if (mouse) {
        // 枠の中を押した = 「ここを操作したい」。**キーを持っていない（`active === false`）
        // ときも効く**のがここの要点で、一覧の行をクリックすると選択が移るのと同じ関係。
        if (mouse.kind === 'press' && insideDialog(mouse.y)) {
          onActivate?.();
        }
        if (mode === 'typing' && composer.handleMouse(mouse)) {
          return;
        }
        // 選択肢のクリックは「カーソルを置く」まで（決定は Enter）。一覧の行を
        // クリックしても詳細が開かないのと同じ関係にしてある。
        if (mouse.kind === 'press') {
          const hit = choiceAtRow(mouse.y);
          if (hit !== undefined) {
            // 押した位置を保留したままモード（= 入力欄の有無）が変わると、次の release で
            // 古い index にキャレットが戻る。ここで必ず捨てる。
            composer.clearSelection();
            setCursor(hit);
            setMode('select');
          }
        }
        return;
      }
      // キーを持っていないとき（一覧の list ゾーン）は表示だけ。マウスは上で扱うので、
      // ここから先だけを `active` で閉じる。
      if (!active) {
        return;
      }
      // modifyOtherKeys / CSI-u を送る端末（Ghostty/xterm 等）では Space や Enter が
      // 生のエスケープ列（`[27;1;32~` / `[32u`）で届く。Ink はこれを素の ' ' に
      // 解釈しないため、一覧/詳細ビューと同じく chord を復号してから扱う。復号しないと
      // `input === ' '` が外れて複数選択のトグルができない。
      const { input, key } = normalizeChord(rawInput, rawKey);
      // 自由記述モード: テキスト編集に専念（Enter で送信、Shift+Enter で改行）。判定は
      // 共通の `useComposer` に委譲するので、一覧・詳細のコンポーザと挙動が揃う。
      // 「選択へ戻る」は空バッファでの Backspace で行う。Esc は背後の view
      // （一覧/詳細）が先取りして戻る/フォーカス移動に使うため、ここでは使わない。
      if (mode === 'typing') {
        composer.clearSelection();
        if ((key.backspace || key.delete) && bufferRef.current.value.length === 0) {
          setMode('select');
          return;
        }
        const result = composer.handleKey(input, key);
        if (result.kind === 'submit' && result.text.length > 0) {
          submit(result.text);
        }
        return;
      }

      // 選択モード
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(chatIndex, c + 1));
        return;
      }
      // Space は複数選択の実選択肢に対してのみトグル（特別項目には効かない）。
      if (input === ' ' && current.multiSelect && cursor < optionCount) {
        const label = current.options[cursor]?.label;
        if (label) {
          setMulti((prev) => {
            const nextSet = new Set(prev);
            if (nextSet.has(label)) {
              nextSet.delete(label);
            } else {
              nextSet.add(label);
            }
            return nextSet;
          });
        }
        return;
      }
      if (key.return) {
        // 「これについて相談する」: 質問をスキップしてツールを拒否 → 会話へ戻す。
        if (cursor === chatIndex) {
          onDeny(m.permission.chatMessage);
          return;
        }
        // 「自分で入力する」: 自由記述モードへ切り替える。**書きかけは消さない** —
        // 選択肢をクリックすると select モードへ戻るので、ここで reset すると
        // 「触ってしまって書き直し」になる（質問が進むときは submit 側で空にしている）。
        if (cursor === typeIndex) {
          composer.clearSelection();
          setMode('typing');
          return;
        }
        const chosen = current.multiSelect
          ? [...multi].join(', ')
          : (current.options[cursor]?.label ?? '');
        submit(chosen);
      }
    },
    // **`isActive` で止めない**（マウスだけは受け取る）。キーの無効化はハンドラの中で
    // `active` を見て行う — クリックでこのダイアログへフォーカスを移す導線
    // （`onActivate`）は、キーを持っていない状態でこそ必要になる。
  );

  if (!current) {
    return null;
  }

  // 区切り線幅（枠内に収まる範囲でほどほどに）。
  const dividerWidth = Math.min(40, width);

  return (
    <Box
      ref={boxRef}
      flexDirection="column"
      borderStyle="round"
      // ToolDialog と同じ: 操作を受け付けない間は枠を落とす。
      borderColor={active ? statusColor.awaitingInput : theme.dim}
      paddingX={1}
      flexShrink={0}
    >
      <Text color={statusColor.awaitingInput} bold>
        {m.permission.questionTitle(qIndex + 1, questions.length, current.header)}
      </Text>
      <Text>{current.question}</Text>
      {/* 実選択肢 + 「自分で入力する」。**当たり判定と同じ `visibleItems` から描く** —
          別々に組み立てると prefix（= 折返し幅）が食い違い、クリックが別の行に当たる。
          `ref` はクリック位置の逆算用（この Box の上端がインジケータ／選択肢の 1 行目）。
          高さの上限を超えるぶんは窓の外へ出す（↑↓ でカーソルを送るとスクロールする）。
          黙って切らない: 隠れている件数をインジケータに出す（一覧の `listView` と同じ）。 */}
      <Box ref={mainRef} flexDirection="column" marginTop={1}>
        {view.showAbove ? <Text dimColor>{m.permission.moreAbove(view.hiddenAbove)}</Text> : null}
        {visibleItems.map((item, i) => (
          <ChoiceRow
            key={item.choice.label}
            prefix={item.prefix}
            label={item.choice.label}
            description={item.choice.description}
            active={cursor === view.start + i}
            width={width}
          />
        ))}
        {view.showBelow ? <Text dimColor>{m.permission.moreBelow(view.hiddenBelow)}</Text> : null}
      </Box>

      {mode === 'typing' ? (
        <Box marginTop={1} flexDirection="column">
          {/* focused は端末カーソル（IME の未確定文字列の描画位置）も決める。操作を
              受け付けない間はキャレットを出さない（1画面 1 useCursor を守る）。 */}
          <Composer
            composer={composer}
            focused={active}
            placeholder={m.permission.typePlaceholder}
          />
        </Box>
      ) : null}

      {/* 区切り線 + 「これについて相談する」— 質問をスキップして会話へ戻る導線。
          当たり判定はこの Box の上端 + 1 行（区切り線）から数える。 */}
      <Box ref={chatRef} flexDirection="column" marginTop={1}>
        <Text dimColor>{'─'.repeat(dividerWidth)}</Text>
        <ChoiceRow
          prefix={chatItem.prefix}
          label={chatItem.choice.label}
          active={cursor === chatIndex}
          width={width}
        />
      </Box>

      <Box marginTop={1}>
        {/* 高さの見積り（`otherRows`）と**同じ文字列**を描く。 */}
        <Text dimColor>{hintText}</Text>
      </Box>
    </Box>
  );
};
