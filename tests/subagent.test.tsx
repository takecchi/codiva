import { describe, expect, it } from 'vitest';
import { App } from '@/app';
import { messages } from '@/core/i18n';
import { asMsg, drivenManager, flush, renderFullscreen, settle, stripAnsi } from './helpers';

const m = messages.ja;

const TOOL_USE_ID = 'toolu_sub_1';
const TASK_ID = 'task-1';

/** `system/task_started`（実データと同じ形）。 */
const started = (taskId: string, toolUseId: string, description: string) =>
  asMsg({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: 'general-purpose',
    task_type: 'local_agent',
    prompt: 'do the thing',
  });

const progress = (taskId: string, description: string, lastTool: string) =>
  asMsg({
    type: 'system',
    subtype: 'task_progress',
    task_id: taskId,
    description,
    last_tool_name: lastTool,
  });

const settled = (taskId: string, status: string, summary: string) =>
  asMsg({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    summary,
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 4_000 },
  });

/** サブエージェント内部の tool_use（`parent_tool_use_id` 付き）。 */
const innerTool = (toolUseId: string, path: string) =>
  asMsg({
    type: 'assistant',
    parent_tool_use_id: toolUseId,
    message: {
      content: [{ type: 'tool_use', id: 'inner-1', name: 'Write', input: { file_path: path } }],
    },
  });

/**
 * セッションを 1 本作って詳細ビューを開く。以降 `out.push(...)` でストリームを駆動する。
 */
async function openDetail(rows = 24, columns = 100) {
  const { manager, out } = drivenManager();
  const harness = renderFullscreen(<App manager={manager} />, rows, columns);
  const { stdin, lastFrame } = harness;
  stdin.write('build it');
  await flush();
  stdin.write('\r');
  await flush();
  out.push(asMsg({ type: 'system', subtype: 'init', session_id: 'sdk-sub' }));
  await settle(lastFrame);
  stdin.write('\t'); // focus the list
  await flush();
  stdin.write('\r'); // Enter → detail
  await settle(lastFrame);
  return { ...harness, manager, out };
}

const rowsOf = (frame: string): string[] => stripAnsi(frame).split('\n');

describe('サブエージェントの実行状況（詳細ビュー下段の 1 行）', () => {
  it('走り始めると種別・状態・説明・直近のツールが 1 行に出る', async () => {
    const { out, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    out.push(progress(TASK_ID, 'Writing report.txt', 'Write'));
    await settle(lastFrame);
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain('general-purpose');
    expect(frame).toContain(m.subagent.statusRunning);
    expect(frame).toContain('Writing report.txt');
    expect(frame).toContain('Write');
    app.unmount();
  });

  /**
   * **高さ不変の番人。** この行はログの兄弟なので、出し入れするとログの可視域が
   * 1 行変わって「↑ を押しても上端が動かない」「ターンごとに画面が揺れる」に戻る。
   */
  it('0 件 / 1 件 / 複数件でフレームの行数が変わらない', async () => {
    const { out, lastFrame, app } = await openDetail();
    const before = rowsOf(lastFrame()).length;
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    const one = rowsOf(lastFrame()).length;
    out.push(started('task-2', 'toolu_sub_2', 'Explore'));
    out.push(started('task-3', 'toolu_sub_3', 'Review'));
    await settle(lastFrame);
    const many = rowsOf(lastFrame()).length;
    expect(one).toBe(before);
    expect(many).toBe(before);
    // 複数件は代表 + 「他 N 件」に畳む（1 行を超えない）。
    expect(stripAnsi(lastFrame())).toContain('他 2 件');
    app.unmount();
  });

  it('決着すると状態ラベルが変わる（記録は残る）', async () => {
    const { out, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    out.push(settled(TASK_ID, 'completed', 'all good'));
    await settle(lastFrame);
    const frame = stripAnsi(lastFrame());
    expect(frame).toContain(m.subagent.statusDone);
    expect(frame).not.toContain(m.subagent.statusRunning);
    app.unmount();
  });

  it('内部のツール実行は親のログに混ざらない', async () => {
    const { out, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    out.push(innerTool(TOOL_USE_ID, '/tmp/report.txt'));
    await settle(lastFrame);
    // 親のログには出ない（専用ログへ振り分けられている）。
    expect(stripAnsi(lastFrame())).not.toContain('Write /tmp/report.txt');
    app.unmount();
  });
});

describe('サブエージェント専用のログ画面', () => {
  /** ログ下段の行の座標を探して press → release を合成する。 */
  function clickRow(
    stdin: { write: (data: string) => void },
    frame: string,
    needle: string,
    column = 4,
  ): boolean {
    const index = rowsOf(frame).findIndex((row) => row.includes(needle));
    if (index < 0) {
      return false;
    }
    // SGR: 1-based。行 index はフレームの 0-based 行に対応する。
    stdin.write(`\x1b[<0;${String(column)};${String(index + 1)}M`);
    stdin.write(`\x1b[<0;${String(column)};${String(index + 1)}m`);
    return true;
  }

  it('1 件のときはクリックで直接開き、Esc で詳細へ戻る', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    out.push(innerTool(TOOL_USE_ID, '/tmp/report.txt'));
    await settle(lastFrame);

    expect(clickRow(stdin, lastFrame(), m.subagent.statusRunning)).toBe(true);
    await settle(lastFrame);
    const opened = stripAnsi(lastFrame());
    // 専用画面: ヘッダに種別、ログに内部のツール実行、フッタに戻り方。
    expect(opened).toContain(m.subagent.title('general-purpose'));
    expect(opened).toContain('Write /tmp/report.txt');
    // **入力欄は無い**（サブエージェントに指示は送れない）。
    expect(opened).not.toContain(m.detail.followupPlaceholder(''));

    stdin.write('\x1b');
    await settle(lastFrame);
    // 詳細へ戻る（一覧まで飛ばない）。
    expect(stripAnsi(lastFrame())).toContain(m.detail.followupPlaceholder('Claude'));
    app.unmount();
  });

  it('press だけ・右クリックでは開かない（副作用は左ボタンの release だけ）', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    const index = rowsOf(lastFrame()).findIndex((row) => row.includes(m.subagent.statusRunning));
    expect(index).toBeGreaterThanOrEqual(0);
    const y = String(index + 1);

    // press だけ（離していない）→ 遷移しない。
    stdin.write(`\x1b[<0;4;${y}M`);
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain(m.subagent.title('general-purpose'));

    // press → drag → release（範囲選択のつもり）→ 遷移しない。
    stdin.write(`\x1b[<32;20;${y}M`);
    stdin.write(`\x1b[<0;20;${y}m`);
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain(m.subagent.title('general-purpose'));

    // 右ボタン（端末のコンテキストメニューを期待した操作）→ 遷移しない。
    stdin.write(`\x1b[<2;4;${y}M`);
    stdin.write(`\x1b[<2;4;${y}m`);
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain(m.subagent.title('general-purpose'));
    app.unmount();
  });

  it('行末より右の余白をクリックしても開かない', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    // ラベルよりずっと右（何も描かれていない余白）。
    expect(clickRow(stdin, lastFrame(), m.subagent.statusRunning, 95)).toBe(true);
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain(m.subagent.title('general-purpose'));
    app.unmount();
  });
});

describe('/subagents コマンド', () => {
  it('1 件も無ければ通知だけ出して遷移しない', async () => {
    const { stdin, lastFrame, app } = await openDetail();
    stdin.write('/subagents');
    await flush();
    stdin.write('\r');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.subagent.empty);
    app.unmount();
  });

  it('1 件なら直接開く', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    stdin.write('/subagents');
    await flush();
    stdin.write('\r');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.subagent.title('general-purpose'));
    app.unmount();
  });

  it('複数件なら選択ダイアログ → ↑↓ で選び Enter で開く', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    out.push(started('task-2', 'toolu_sub_2', 'Explore the repo'));
    await settle(lastFrame);
    stdin.write('/subagents');
    await flush();
    stdin.write('\r');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.subagent.pickerTitle);

    // ダイアログ表示中は印字キーがコンポーザに入らない（全部飲む）。
    stdin.write('zzz');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain('zzz');

    stdin.write('\r'); // Enter → 開く
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.subagent.title('general-purpose'));
    app.unmount();
  });

  it('選択ダイアログは Esc で閉じ、コンポーザは元のまま', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    out.push(started('task-2', 'toolu_sub_2', 'Explore the repo'));
    await settle(lastFrame);
    stdin.write('/subagents');
    await flush();
    stdin.write('\r');
    await settle(lastFrame);
    stdin.write('\x1b');
    await settle(lastFrame);
    const frame = stripAnsi(lastFrame());
    expect(frame).not.toContain(m.subagent.pickerTitle);
    // 詳細ビューに留まる（一覧へ抜けない）。
    expect(frame).toContain(m.detail.followupPlaceholder('Claude'));
    app.unmount();
  });
});

describe('記録が残っていないサブエージェント', () => {
  it('gone を出し、Esc で詳細へ戻れる（自動では戻さない）', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    stdin.write('/subagents');
    await flush();
    stdin.write('\r');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.subagent.title('general-purpose'));

    // CLI プロセスが起き直っても記録は残る（封じられるだけ）ので、`gone` は
    // 「記録そのものが無い」ときだけ。ここでは空ログの表示を確かめる。
    expect(stripAnsi(lastFrame())).toContain(m.subagent.emptyLog);
    stdin.write('\x1b');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.detail.followupPlaceholder('Claude'));
    app.unmount();
  });
});

describe('ログのスクロール（行を増やしていないことの確認）', () => {
  /**
   * サブエージェント行を独立した行にすると `DETAIL_CHROME_ROWS` が 1 増え、
   * そこから引き算する `dialogMaxRows` のせいで低い端末の質問ダイアログが壊れる。
   * ここでは「行が増えていない = 末尾から ↑ 1 回でちゃんと 1 行動く」を確かめる。
   */
  it('末尾から ↑ を 1 回押すと過去ログの案内が出る', async () => {
    const { out, stdin, lastFrame, app } = await openDetail();
    for (let i = 1; i <= 60; i += 1) {
      out.push(
        asMsg({
          type: 'assistant',
          parent_tool_use_id: null,
          message: { content: [{ type: 'text', text: `log-${String(i)}` }] },
        }),
      );
    }
    out.push(started(TASK_ID, TOOL_USE_ID, 'Create report'));
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).not.toContain('過去ログ');
    stdin.write('\x1b[A');
    await settle(lastFrame);
    expect(stripAnsi(lastFrame())).toContain(m.detail.scrollHint(1));
    app.unmount();
  });
});
