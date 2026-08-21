import type { LogEntry } from './types';

/**
 * エージェント切替（`/agent`）のときに、引き継ぐ側へ渡す最初の状況説明を組み立てる（純粋）。
 *
 * なぜ要るか: 切替先は**前の会話を持たない**（モデル側の文脈は provider をまたげず、
 * 各 CLI が自分のトランスクリプトを持つ）。共有されているのは worktree だけなので、
 * 何も渡さないと切替先は「途中まで作業された作業ツリー」を白紙から見ることになり、
 * 済んだ作業をやり直したり、直前の指示を無視したりする。
 *
 * **AI 向けの文字列なので i18n カタログには置かない**（`core/system-prompt.ts` の
 * `SHARED_IGNORED_FILES_NOTICE` / `utils/title.ts` の `TITLE_INSTRUCTION` と同じ扱いで
 * 英語固定）。切替後の最初のユーザープロンプトにだけ内部的に前置される
 * （次のターン以降には持ち越さない）。resume 時に system prompt を再適用しない
 * provider にも確実に渡すため、この形にしている。
 */

/**
 * 1 項目に載せる最大文字数。指示文はファイルを丸ごと貼り付けたものになりうるので、
 * systemPrompt が本文より大きくなる（= 毎ターン全部読ませる）のを防ぐために切る。
 * 切ったことは `…` で示す（黙って切らない）。
 */
export const MAX_HANDOFF_FIELD_CHARS = 600;

/**
 * 会話履歴を引き継ぐ最大文字数。codiva の表示ログ自体は 400k 文字まで保持するが、
 * それを丸ごと system prompt にすると切替だけで巨大なコンテキストを消費する。
 * 新しい会話から優先して収め、切れたことは明示する。
 */
export const MAX_HANDOFF_TRANSCRIPT_CHARS = 80_000;

export interface HandoffInput {
  /** 引き継ぐ側の表示名（切替前のエージェント）。 */
  from: string;
  /** セッションの worktree ブランチ。 */
  branch?: string;
  /** セッションの最初の指示（そのセッションの目的）。 */
  task?: string;
  /** 直前にユーザーが送った指示（最初の指示と同じなら省く）。 */
  lastInstruction?: string;
  /** codiva が保持している会話ログ。user / assistant_text の双方を引き継ぐ。 */
  messages?: readonly LogEntry[];
}

/** Provider に送る最初の指示へ、内部の引き継ぎ情報を前置する。 */
export function attachHandoff(text: string, handoff: string | undefined): string {
  return handoff ? `${handoff}\n\n# Current instruction after the switch\n\n${text}` : text;
}

/** 1 行に畳んで長すぎるものを切る（systemPrompt の箇条書きに収めるため）。 */
function field(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) {
    return undefined;
  }
  return flat.length > MAX_HANDOFF_FIELD_CHARS
    ? `${flat.slice(0, MAX_HANDOFF_FIELD_CHARS)}…`
    : flat;
}

/**
 * ログから直前のユーザー指示を拾う（`kind: 'user'` の最後の 1 件）。復元した
 * トランスクリプト由来の行も同じ kind なので、再起動をまたいでも拾える。
 */
export function lastUserInstruction(messages: readonly LogEntry[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (entry?.kind === 'user') {
      return entry.text;
    }
  }
  return undefined;
}

/**
 * codiva の表示ログから、切替先へ渡す会話 transcript を作る。
 * ツール実行・system/error 行は作業ツリーを見れば確認でき、量も大きいため除外する。
 */
export function handoffTranscript(messages: readonly LogEntry[]): string | undefined {
  const turns = messages
    .filter((entry) => entry.kind === 'user' || entry.kind === 'assistant_text')
    .map((entry) => {
      const role = entry.kind === 'user' ? 'User' : 'Assistant';
      const agent = entry.agent ? ` (${entry.agent})` : '';
      return `${role}${agent}:\n${entry.text.trim()}`;
    })
    .filter((turn) => !turn.endsWith(':\n'));
  if (turns.length === 0) {
    return undefined;
  }

  const kept: string[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) {
      continue;
    }
    const separator = kept.length === 0 ? 0 : 2;
    if (chars + separator + turn.length > MAX_HANDOFF_TRANSCRIPT_CHARS) {
      break;
    }
    kept.unshift(turn);
    chars += separator + turn.length;
  }
  const omitted = kept.length < turns.length;
  return [
    ...(omitted
      ? ['[Earlier conversation omitted because the handover reached its size limit.]']
      : []),
    ...kept,
  ].join('\n\n');
}

/**
 * 引き継ぎの指示文。渡せる材料が何も無ければ `undefined`（`composeSystemPrompt` と
 * 同じで、無いものは足さない）。
 *
 * 「作業ツリーを自分で確かめてから続ける」ことを明示するのが要点 — 引き継ぎ先は
 * 差分の中身までは知りようがなく、要約を信じて上書きするより `git status` /
 * `git diff` を読んでもらった方が確実（実際の状況は codiva が文章にした瞬間から古い）。
 */
export function handoffInstruction(input: HandoffInput): string | undefined {
  const task = field(input.task);
  const last = field(input.lastInstruction);
  const branch = field(input.branch);
  const transcript = handoffTranscript(input.messages ?? []);
  if (!task && !last && !branch && !transcript) {
    return undefined;
  }
  const lines = [
    '# Session handover (codiva)',
    '',
    `You are taking over this session from ${input.from}. The providers cannot share their`,
    'native session, so codiva has copied the user/assistant conversation below.',
    '',
  ];
  if (branch) {
    lines.push(`- Branch: ${branch}`);
  }
  if (task) {
    lines.push(`- Original task: ${task}`);
  }
  if (last && last !== task) {
    lines.push(`- Most recent instruction: ${last}`);
  }
  if (transcript) {
    lines.push(
      '',
      '## Conversation before the switch',
      '',
      'Treat this as the prior conversation in the same task. Continue from it; do not ask the',
      'user to repeat information already present here.',
      '',
      '<conversation-history>',
      transcript,
      '</conversation-history>',
    );
  }
  lines.push(
    '',
    'Before doing anything, inspect the working tree yourself (`git status`, `git diff`,',
    '`git log`) to see what is already done, and continue from there. Do not redo or revert',
    'work that is already committed.',
  );
  return lines.join('\n');
}
