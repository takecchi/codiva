import { Box, Text, useInput } from 'ink';
import { type FC, useState } from 'react';
import type { PermissionRequest } from '@/core';

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
}> = ({ request, onAnswer, onAllow, onDeny }) => {
  if (request.kind === 'question') {
    return <QuestionDialog request={request} onAnswer={onAnswer} />;
  }
  return <ToolDialog request={request} onAllow={onAllow} onDeny={onDeny} />;
};

const ToolDialog: FC<{
  request: PermissionRequest;
  onAllow: () => void;
  onDeny: (message: string) => void;
}> = ({ request, onAllow, onDeny }) => {
  useInput((input) => {
    if (input === 'y' || input === 'Y') {
      onAllow();
    } else if (input === 'n' || input === 'N') {
      onDeny('ユーザーが拒否しました');
    }
  });

  const summary = JSON.stringify(request.input).slice(0, 200);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ツール実行の許可: {request.toolName}
      </Text>
      <Text dimColor wrap="truncate-end">
        {summary}
      </Text>
      <Text>
        <Text color="green">y</Text>: 許可 ・ <Text color="red">n</Text>: 拒否
      </Text>
    </Box>
  );
};

const QuestionDialog: FC<{
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
}> = ({ request, onAnswer }) => {
  const questions = request.questions ?? [];
  const [qIndex, setQIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [multi, setMulti] = useState<Set<string>>(new Set());

  const current = questions[qIndex];

  useInput((input, key) => {
    if (!current) {
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(current.options.length - 1, c + 1));
      return;
    }
    if (input === ' ' && current.multiSelect) {
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
      const chosen = current.multiSelect
        ? [...multi].join(', ')
        : (current.options[cursor]?.label ?? '');
      const nextAnswers = { ...answers, [current.question]: chosen };
      if (qIndex < questions.length - 1) {
        setAnswers(nextAnswers);
        setQIndex(qIndex + 1);
        setCursor(0);
        setMulti(new Set());
      } else {
        onAnswer(nextAnswers);
      }
    }
  });

  if (!current) {
    return null;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        質問 ({qIndex + 1}/{questions.length}) {current.header}
      </Text>
      <Text>{current.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {current.options.map((opt, i) => {
          const checked = current.multiSelect && multi.has(opt.label);
          const marker = current.multiSelect ? (checked ? '[x]' : '[ ]') : i === cursor ? '❯' : ' ';
          return (
            <Box key={opt.label}>
              <Text color={i === cursor ? 'cyan' : undefined}>
                {marker} {opt.label}
              </Text>
              {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓: 選択 ・ {current.multiSelect ? 'Space: トグル ・ ' : ''}Enter: 決定
        </Text>
      </Box>
    </Box>
  );
};
