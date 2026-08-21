import type { LogEntry } from './types';

/**
 * エージェント切替（`/agent`）のときに、引き継ぐ側へ渡す最初の状況説明を組み立てる（純粋）。
 *
 * なぜ要るか: 切替先は**前の会話を持たない**（モデル側の文脈は provider をまたげず、
 * 各 CLI が自分のトランスクリプトを持つ）。共有されているのは worktree だけなので、
 * 何も渡さないと切替先は「途中まで作業された作業ツリー」を白紙から見ることになり、
 * 済んだ作業をやり直したり、直前の指示を無視したりする。そこで codiva 側が持っている
 * 会話ログ（user / assistant_text）を写して渡す（`handoffTranscript`）。
 *
 * **往復切替では重複を許す**。切替先が過去に自分のスレッドを持っていれば resume される
 * ので、そのぶんは向こうの文脈と重なる。それでも全部渡すのは、resume が失敗したり
 * 圧縮で落ちていたりしたときに「渡しすぎ」より「足りない」方が害が大きいため
 * （重複していても新しい指示ではないことは引き継ぎ文の中で断ってある）。
 *
 * **AI 向けの文字列なので i18n カタログには置かない**（`core/system-prompt.ts` の
 * `SHARED_IGNORED_FILES_NOTICE` / `utils/title.ts` の `TITLE_INSTRUCTION` と同じ扱いで
 * 英語固定）。切替後の最初のユーザープロンプトにだけ内部的に前置される
 * （次のターン以降には持ち越さない）。resume 時に system prompt を再適用しない
 * provider にも確実に渡すため、この形にしている。
 */

/**
 * 見出しの 1 項目に載せる最大文字数。指示文はファイルを丸ごと貼り付けたものになりうるので、
 * 概要の箇条書きが会話本体より大きくなるのを防ぐために切る（会話そのものは下の
 * {@link MAX_HANDOFF_TRANSCRIPT_BYTES} が別に面倒を見る）。切ったことは `…` で示す
 * （黙って切らない）。
 */
export const MAX_HANDOFF_FIELD_CHARS = 600;

/**
 * 会話履歴を引き継ぐ最大サイズ（**UTF-8 バイト**）。codiva の表示ログ自体は 400k 文字まで
 * 保持するが、それを丸ごと渡すと切替だけで巨大なコンテキストを消費する。新しい会話から
 * 優先して収め、切れたことは明示する。
 *
 * **文字数ではなくバイト数で測る。** Codex は指示文を **argv で渡す**ため
 * （`utils/codex.ts` の `codexArgs` = `codex exec … -- <prompt>`）、Linux の `execve` が
 * 課す引数 1 本あたりの上限 `MAX_ARG_STRLEN`（32 ページ = 131,072 バイト）に当たると
 * `E2BIG` で起動そのものが落ちる。日本語は 1 文字 3 バイトなので「文字数」で 80,000 を
 * 許すと最大 240 KiB になり、**日本語で長く続けたセッションを Codex へ切り替えた瞬間に
 * spawn が失敗する**。しかも Codex アダプタは `thread.started` を見るまで引き継ぎを
 * 持ち続けるので、以後どのターンも同じ理由で落ち続けてセッションが詰む。
 *
 * 値の根拠: 同じ argv には systemPrompt（`SHARED_IGNORED_FILES_NOTICE` ≒ 3.5 KiB +
 * リポジトリ追加指示）とユーザーの指示文も載る。64 KiB 弱に抑えておけば、上限まで
 * 使い切ってもユーザーの指示に 60 KiB 以上の余地が残る。
 *
 * 併せて「直近の 1 ターンは必ず入る」ことも保証する: ログの 1 件は
 * `MAX_LOG_ENTRY_CHARS`（20,000 文字 ⇒ 最大 60,000 バイト）に切られているので、
 * この予算はそれを必ず上回っていること（番人は `agent-handoff.spec.ts`）。
 */
export const MAX_HANDOFF_TRANSCRIPT_BYTES = 64_000;

/** 省略が起きたことを引き継ぎ先に明示する 1 行（黙って切らない）。 */
const OMITTED_MARKER = '[Older conversation omitted: the handover reached its size limit.]';

/** ターンの区切り（`join('\n\n')`）のぶん。予算にはこれも数える。 */
const SEPARATOR_BYTES = 2;

const UTF8 = new TextEncoder();

/** UTF-8 でのバイト長（argv に載る実サイズ。`.length` は UTF-16 の符号単位数）。 */
function utf8Length(text: string): number {
  return UTF8.encode(text).length;
}

/** 会話履歴ブロックの開始・終了タグ（{@link fitHandoff} が削る範囲の目印）。 */
const HISTORY_OPEN = '<conversation-history>';
const HISTORY_CLOSE = '</conversation-history>';

/**
 * 組み立て済みの引き継ぎを、指定バイト数（UTF-8）に収める（純粋）。
 *
 * なぜ要るか: {@link MAX_HANDOFF_TRANSCRIPT_BYTES} は**会話だけ**の予算で、Codex は
 * systemPrompt（`.codiva/prompt.md` は無制限）とユーザーの指示文まで**同じ argv 1 本**に
 * 載せる。合計が Linux の `MAX_ARG_STRLEN`（131,072 バイト）を超えると `spawn` が
 * `E2BIG` で落ち、Codex アダプタは `thread.started` を見るまで引き継ぎを持ち続けるので
 * **以後どのターンも同じ理由で落ち続けてセッションが詰む**。
 *
 * 削るのは**会話履歴の古い側だけ**（見出し・箇条書き・続け方の指示は残す）。ユーザーの
 * 指示文や systemPrompt は削らない — そちらを黙って切ると指示の意味が変わる。
 * 会話を全部落としても収まらないときは undefined（= 引き継ぎ無しで送る）。
 */
export function fitHandoff(handoff: string, budgetBytes: number): string | undefined {
  if (utf8Length(handoff) <= budgetBytes) {
    return handoff;
  }
  const open = handoff.indexOf(`${HISTORY_OPEN}\n`);
  const close = handoff.indexOf(`\n${HISTORY_CLOSE}`);
  if (open === -1 || close === -1 || close < open) {
    return undefined;
  }
  const head = handoff.slice(0, open + HISTORY_OPEN.length + 1);
  const tail = handoff.slice(close);
  const fixed = utf8Length(head) + utf8Length(tail);
  const turns = handoff.slice(open + HISTORY_OPEN.length + 1, close).split('\n\n');
  // 新しい側から詰め直す（切替直後に効くのは直近の文脈）。
  const kept: string[] = [];
  let bytes = fixed + utf8Length(OMITTED_MARKER) + SEPARATOR_BYTES;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) {
      continue;
    }
    const size = utf8Length(turn) + (kept.length === 0 ? 0 : SEPARATOR_BYTES);
    if (bytes + size > budgetBytes) {
      break;
    }
    kept.unshift(turn);
    bytes += size;
  }
  if (kept.length === 0) {
    // 1 ターンも入らない = 会話を載せる余地が無い。引き継ぎ自体を諦める
    // （黙って壊れるより、渡せなかったことをはっきりさせる）。
    return undefined;
  }
  return `${head}${[OMITTED_MARKER, ...kept].join('\n\n')}${tail}`;
}

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

/** 引き継ぎの見出し。復元時に「引き継ぎ付きのプロンプト」を見分ける目印も兼ねる。 */
export const HANDOFF_HEADING = '# Session handover (codiva)';

/** 引き継ぎと「ユーザーが実際に打った指示」の境目。 */
const CURRENT_INSTRUCTION_HEADING = '# Current instruction after the switch';

/** Provider に送る最初の指示へ、内部の引き継ぎ情報を前置する。 */
export function attachHandoff(text: string, handoff: string | undefined): string {
  return handoff ? `${handoff}\n\n${CURRENT_INSTRUCTION_HEADING}\n\n${text}` : text;
}

/**
 * 引き継ぎを前置したプロンプトから、ユーザーが実際に打った指示だけを取り出す（純粋）。
 *
 * なぜ要るか: 引き継ぎは provider には**ユーザーメッセージ**として届くので、CLI の
 * トランスクリプトにもそう記録される。それをそのまま復元すると、
 * (1) 詳細ビューに「ユーザーが打った覚えのない巨大なブロック」が並び、
 * (2) `lastUserInstruction` が引き継ぎの見出しを直前の指示として拾い、
 * (3) 次の切替でその引き継ぎが会話ごと入れ子に写される。
 * 復元は `core/transcript.ts` の唯一の入口（`appendUserLine`）で通す。
 */
export function stripHandoff(text: string): string {
  if (!text.startsWith(HANDOFF_HEADING)) {
    return text;
  }
  const marker = `\n\n${CURRENT_INSTRUCTION_HEADING}\n\n`;
  // **最後の**境目で切る。`attachHandoff` はこの見出しを最上位の区切りとして
  // 末尾に 1 回だけ置くが、引き継ぎの本文には会話ログ（= 任意のユーザー・
  // アシスタント発話）がそのまま入るので、同じ行が中に現れることがある。
  // `indexOf` だとそこで切ってしまい、**引き継ぎの残骸がユーザー発言として**
  // ログに載る（それが `lastUserInstruction` に拾われ、次の切替で入れ子に写る）。
  const at = text.lastIndexOf(marker);
  return at === -1 ? text : text.slice(at + marker.length);
}

/** 1 行に畳んで長すぎるものを切る（引き継ぎの箇条書きに収めるため）。 */
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
  const turns: string[] = [];
  for (const entry of messages) {
    if (entry.kind !== 'user' && entry.kind !== 'assistant_text') {
      continue;
    }
    // 空行（本文の無いターン）は載せない。判定は整形後の文字列ではなく**本文**で行う
    // （`…:\n` で終わるかを見る形だと、役割ラベルの書式を変えた瞬間に黙って壊れる）。
    const text = entry.text.trim();
    if (!text) {
      continue;
    }
    const role = entry.kind === 'user' ? 'User' : 'Assistant';
    // 帰属が入るのは**切替後のエージェントの発言だけ**（`LogEntry.agent`）。ユーザーの
    // 指示は誰が受けても「ユーザー」なので付かない。切替の境目はこの印で読める。
    const agent = entry.agent ? ` (${entry.agent})` : '';
    turns.push(`${role}${agent}:\n${text}`);
  }
  if (turns.length === 0) {
    return undefined;
  }

  // 新しい会話から詰める（切替直後に効くのは直近の文脈）。省略の断り書き自身も
  // argv に載るので予算に数える。
  const kept: string[] = [];
  let bytes = utf8Length(OMITTED_MARKER) + SEPARATOR_BYTES;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn === undefined) {
      continue;
    }
    const size = utf8Length(turn) + (kept.length === 0 ? 0 : SEPARATOR_BYTES);
    if (bytes + size > MAX_HANDOFF_TRANSCRIPT_BYTES) {
      break;
    }
    kept.unshift(turn);
    bytes += size;
  }
  if (kept.length === turns.length) {
    return kept.join('\n\n');
  }
  // 1 件も入らないのは想定外（`MAX_LOG_ENTRY_CHARS` が 1 件の上限なので、予算がそれを
  // 上回っている限り直近の 1 ターンは必ず入る）。それでも黙って空を返さず断り書きは出す。
  return [OMITTED_MARKER, ...kept].join('\n\n');
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
  // 会話を載せられたかで前置きを変える。常に「下に会話を写した」と名乗ると、ログが
  // 空のセッション（トランスクリプト復元に失敗した復元セッション等）で嘘になる。
  const lines = [
    HANDOFF_HEADING,
    '',
    ...(transcript
      ? [
          `You are taking over this session from ${input.from}. The two agents cannot share their`,
          'native session, so codiva has copied the user/assistant conversation below.',
        ]
      : [
          `You are taking over this session from ${input.from}. The previous agent's conversation`,
          'history is NOT available to you — only the working tree it left behind is shared.',
        ]),
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
      'user to repeat information already present here. If you worked on this session before',
      'the switch, some of it may already be in your own context — repeated lines are not new',
      'instructions.',
      '',
      HISTORY_OPEN,
      transcript,
      HISTORY_CLOSE,
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
