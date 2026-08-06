import { Box, Text, useInput, useWindowSize } from 'ink';
import { type FC, useState } from 'react';
import { choiceLines, dialogContentWidth, type PermissionRequest, parseSgrMouse } from '@/core';
import { ChoiceRow } from './choice-row';
import { Composer, useComposer } from './composer';
import { useMessages } from './i18n-context';
import { normalizeChord } from './input';
import { statusColor, theme } from './theme';

/**
 * Renders the pending decision a session is blocked on and captures the user's
 * response. Two shapes:
 *  - kind 'question' (AskUserQuestion): pick an option per question → onAnswer
 *  - kind 'tool': allow / deny a tool call → onAllow / onDeny
 * This owns the active key handler while a decision is pending.
 */
export const PermissionDialog: FC<{
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onAllow: () => void;
  onDeny: (message: string) => void;
  /** 自由記述欄のマウス範囲選択をクリップボードへ（OSC 52）。合成ルートから注入。 */
  onCopy?: (text: string) => void;
}> = ({ request, onAnswer, onAllow, onDeny, onCopy }) => {
  if (request.kind === 'question') {
    return <QuestionDialog request={request} onAnswer={onAnswer} onDeny={onDeny} onCopy={onCopy} />;
  }
  return <ToolDialog request={request} onAllow={onAllow} onDeny={onDeny} />;
};

const ToolDialog: FC<{
  request: PermissionRequest;
  onAllow: () => void;
  onDeny: (message: string) => void;
}> = ({ request, onAllow, onDeny }) => {
  const m = useMessages();
  const { columns } = useWindowSize();
  useInput((rawInput, rawKey) => {
    // マウスレポートを先に握り潰す。モーダルは自分の useInput を持つので背後の view の
    // 先取り解釈では守られず、クリック/ホイールの列が y/n 判定へ流れ込む（下の
    // QuestionDialog と同じ理由。`repo-prompt-editor` も同じ防御を持つ）。
    if (parseSgrMouse(rawInput)) {
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
      flexDirection="column"
      borderStyle="round"
      borderColor={statusColor.awaitingPermission}
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
      <Text>
        <Text color={theme.yes}>y</Text>: {m.permission.allow} ・ <Text color={theme.no}>n</Text>:{' '}
        {m.permission.deny}
      </Text>
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
 */
const QuestionDialog: FC<{
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onDeny: (message: string) => void;
  onCopy?: (text: string) => void;
}> = ({ request, onAnswer, onDeny, onCopy }) => {
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

  const current = questions[qIndex];
  // 実選択肢の後ろに「自分で入力する」(typeIndex) と「これについて相談する」(chatIndex)
  // を仮想的に並べる。カーソルは [0, chatIndex] を移動する。
  const optionCount = current?.options.length ?? 0;
  const typeIndex = optionCount;
  const chatIndex = optionCount + 1;

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

  useInput((rawInput, rawKey) => {
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
      if (mode === 'typing') {
        composer.handleMouse(mouse);
      }
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
      // 「自分で入力する」: 自由記述モードへ切り替える。
      if (cursor === typeIndex) {
        composer.reset();
        setMode('typing');
        return;
      }
      const chosen = current.multiSelect
        ? [...multi].join(', ')
        : (current.options[cursor]?.label ?? '');
      submit(chosen);
    }
  });

  if (!current) {
    return null;
  }

  // カーソル記号（typing 中はカーソル表示を出さない）。複数選択でもチェックボックスとは
  // 別にこのポインタを出す（`❯ [x] ラベル`）。ポインタが無いとカーソル位置が色でしか
  // 分からず、どの行にいるのか見えない＝「トグルできない」ように見えるため。
  const marker = (i: number) => (mode === 'select' && cursor === i ? '❯' : ' ');
  // 複数選択時はチェックボックス幅（"[x] "）ぶん、特別項目（自分で入力する/相談する）を
  // 字下げして実選択肢と桁を揃える。
  const pad = current.multiSelect ? '    ' : '';
  // ラベル・説明の折返し幅（枠とパディングを引いた本文幅）。ラベルと説明を横に並べず
  // ここで折返すことで、長い文言でも切り捨てずに全文を出す。
  const width = dialogContentWidth(columns);
  // 区切り線幅（枠内に収まる範囲でほどほどに）。
  const dividerWidth = Math.min(40, width);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={statusColor.awaitingInput}
      paddingX={1}
      flexShrink={0}
    >
      <Text color={statusColor.awaitingInput} bold>
        {m.permission.questionTitle(qIndex + 1, questions.length, current.header)}
      </Text>
      <Text>{current.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {current.options.map((opt, i) => {
          const checked = current.multiSelect && multi.has(opt.label);
          // 複数選択: `❯ [x] ラベル`（ポインタ＋チェックボックス）。単一選択: `❯ ラベル`。
          const box = current.multiSelect ? `${checked ? '[x]' : '[ ]'} ` : '';
          return (
            <ChoiceRow
              key={opt.label}
              prefix={`${marker(i)} ${box}`}
              label={opt.label}
              description={opt.description}
              active={cursor === i}
              width={width}
            />
          );
        })}
        {/* 「自分で入力する」— 実選択肢の直後（メインブロックの一部）。 */}
        <ChoiceRow
          prefix={`${marker(typeIndex)} ${pad}`}
          label={m.permission.typeSomething}
          active={cursor === typeIndex}
          width={width}
        />
      </Box>

      {mode === 'typing' ? (
        <Box marginTop={1} flexDirection="column">
          <Composer composer={composer} focused placeholder={m.permission.typePlaceholder} />
        </Box>
      ) : null}

      {/* 区切り線 + 「これについて相談する」— 質問をスキップして会話へ戻る導線。 */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{'─'.repeat(dividerWidth)}</Text>
        <ChoiceRow
          prefix={`${marker(chatIndex)} ${pad}`}
          label={m.permission.chatAboutThis}
          active={cursor === chatIndex}
          width={width}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {mode === 'typing'
            ? m.permission.typingHelp
            : m.permission.questionHelp(current.multiSelect ?? false)}
        </Text>
      </Box>
    </Box>
  );
};
