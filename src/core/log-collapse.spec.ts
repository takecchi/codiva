import { describe, expect, it } from 'vitest';
import { messages } from './i18n';
import { collapsibleRunAt, isToolLogEntry, MIN_COLLAPSE_TOOLS, toolRunLabel } from './log-collapse';
import type { AgentId, AgentToolKind, LogEntry, LogKind } from './types';

let seq = 0;

/** 1 行ぶんの `LogEntry`（seq は自動採番。テスト内で一意ならよい）。 */
function entry(kind: LogKind, tool?: AgentToolKind, agent?: AgentId): LogEntry {
  seq += 1;
  return { seq, kind, text: `${kind}${tool ? ` ${tool}` : ''}`, tool, agent };
}

/** ツール呼び出しとその結果の 2 行組。 */
function call(tool?: AgentToolKind, agent?: AgentId): LogEntry[] {
  return [entry('tool_use', tool, agent), entry('tool_result', undefined, agent)];
}

describe('isToolLogEntry', () => {
  it.each([
    ['tool_use', true],
    ['tool_result', true],
    ['assistant_text', false],
    ['user', false],
    ['system', false],
    ['result', false],
    ['error', false],
  ] as const)('%s → %s', (kind, expected) => {
    expect(isToolLogEntry(entry(kind))).toBe(expected);
  });
});

describe('collapsibleRunAt', () => {
  it('連続したツール実行を 1 まとまりとして返す（内訳つき）', () => {
    const messagesList = [
      entry('user'),
      ...call('read'),
      ...call('shell'),
      ...call('shell'),
      entry('assistant_text'),
    ];
    const run = collapsibleRunAt(messagesList, 1);
    expect(run).toMatchObject({
      key: messagesList[1]?.seq,
      start: 1,
      end: 7,
      tools: 3,
      counts: { read: 1, shell: 2 },
    });
  });

  it('種類を持たないツール行（古いログ・報告しない provider）は other に数える', () => {
    // 末尾に非ツール行を置く（下の「末尾は畳まない」を参照）。
    const list = [entry('user'), ...call(), ...call('edit'), entry('assistant_text')];
    expect(collapsibleRunAt(list, 1)?.counts).toEqual({ other: 1, edit: 1 });
  });

  const notCollapsible: [string, () => LogEntry[], number][] = [
    [
      'ツール呼び出しが 1 件だけなら畳まない（ファイル名が消えて情報が減るだけ）',
      () => [entry('user'), ...call('read'), entry('assistant_text')],
      1,
    ],
    [
      '末尾のまとまりは畳まない（いま動いている作業が見えなくなる）',
      () => [entry('user'), ...call('read'), ...call('shell')],
      1,
    ],
    [
      'tool_result からは始めない（宙に浮いた結果行）',
      () => [entry('tool_result'), ...call('read'), ...call('shell'), entry('assistant_text')],
      0,
    ],
    [
      'ツール行でない位置からは始まらない',
      () => [entry('user'), ...call('read'), ...call('shell'), entry('assistant_text')],
      0,
    ],
  ];
  it.each(notCollapsible)('%s', (_label, build, start) => {
    expect(collapsibleRunAt(build(), start)).toBeUndefined();
  });

  it('エージェントの切替でまとまりを切る（区切り行と帰属が食い違わないように）', () => {
    const list = [
      entry('user'),
      ...call('shell', 'claude'),
      ...call('shell', 'claude'),
      ...call('shell', 'codex'),
      entry('assistant_text', undefined, 'codex'),
    ];
    expect(collapsibleRunAt(list, 1)).toMatchObject({ start: 1, end: 5, tools: 2 });
  });

  it('MIN_COLLAPSE_TOOLS は 2（1 件だけの実行は畳まない）', () => {
    expect(MIN_COLLAPSE_TOOLS).toBe(2);
  });
});

describe('toolRunLabel', () => {
  it('種類の順は挿入順ではなく作業の流れ順（読む → 書く → 走らせる → 探す）', () => {
    const label = toolRunLabel({ shell: 5, read: 1 }, messages.ja);
    expect(label).toBe('1 ファイルを読み込み・5 個のコマンドを実行');
  });

  it('英語カタログは単複を出し分ける', () => {
    expect(toolRunLabel({ read: 1, shell: 5 }, messages.en)).toBe(
      'Read 1 file, ran 5 shell commands',
    );
    expect(toolRunLabel({ read: 2 }, messages.en)).toBe('Read 2 files');
  });

  it('0 件の種類は出さない / 内訳が空なら空文字', () => {
    expect(toolRunLabel({ edit: 2, shell: 0 }, messages.en)).toBe('Edited 2 files');
    expect(toolRunLabel({}, messages.en)).toBe('');
  });
});
