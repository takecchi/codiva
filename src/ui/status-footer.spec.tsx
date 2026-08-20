import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { messages } from '@/core';
import { MessagesProvider } from './i18n-context';
import { StatusFooter } from './status-footer';

function renderFooter(props: Parameters<typeof StatusFooter>[0], lang: 'ja' | 'en' = 'en') {
  return render(
    <MessagesProvider value={messages[lang]}>
      <StatusFooter {...props} />
    </MessagesProvider>,
  );
}

describe('StatusFooter', () => {
  it('モード行と切替ヒントを出す', () => {
    const { lastFrame } = renderFooter({ mode: 'auto' });
    expect(lastFrame()).toContain('auto mode on');
    expect(lastFrame()).toContain('shift+tab');
  });

  it('確認モードでは確認モードの文言を出す', () => {
    const { lastFrame } = renderFooter({ mode: 'confirm' }, 'ja');
    expect(lastFrame()).toContain('確認モード');
  });

  it('許可要求を上げられないエージェントでは確認モードを言い切らない', () => {
    // Codex セッションでは確認ダイアログが原理的に出ない（`permissions: false`）。
    // `confirm mode on` のまま出すと「待っていれば聞かれる」と読めてしまう。
    const { lastFrame } = renderFooter({ mode: 'confirm', confirmSupported: false });
    expect(lastFrame()).toContain('confirm mode (n/a)');
    // 自動モードは capability に関係なく従来どおり（自動実行は嘘にならない）。
    const auto = renderFooter({ mode: 'auto', confirmSupported: false });
    expect(auto.lastFrame()).toContain('auto mode on');
  });

  it('画面固有のヒントをモード行の後ろに繋げる', () => {
    const { lastFrame } = renderFooter({ mode: 'auto', hint: 'Tab: list' });
    expect(lastFrame()).toContain('Tab: list');
  });

  it('プランや使用状況は出さない（ヘッダの担当）', () => {
    // 使用状況をフッタに詰め込むのをやめた回帰テスト。プラン名・ゲージ・枠見出しは
    // ヘッダ（Banner）だけに出す。
    const { lastFrame } = renderFooter({ mode: 'auto', hint: 'hint' }, 'ja');
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hint');
    expect(frame).not.toContain('5時間');
    expect(frame).not.toContain('░');
    expect(frame).not.toContain('%');
  });
});

/**
 * **フッタはどの幅でも1行**（折り返すとログの行を奪い、レイアウト崩れに見える）。
 * 縮むのはヒントだけで、モード表示は必ず残る。ink-testing-library は幅 100 固定なので
 * 自前の stdout で幅を変えて実描画を確認する。
 */
class FakeStdout extends EventEmitter {
  readonly rows = 6;
  readonly frames: string[] = [];
  constructor(readonly columns: number) {
    super();
  }
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

function renderAtWidth(columns: number, lang: 'ja' | 'en' = 'ja') {
  const stdout = new FakeStdout(columns);
  const app = inkRender(
    <MessagesProvider value={messages[lang]}>
      {/* 実際の一覧ビューのヒント程度の長さ（唯一縮む枠）。 */}
      <StatusFooter mode="auto" hint="Tab: 一覧 / Enter: 送信 / /help: コマンド" />
    </MessagesProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      debug: true,
    },
  );
  const frame = stdout.frames.at(-1) ?? '';
  app.unmount();
  const lines = frame.split('\n').filter((l) => l.trim().length > 0);
  return { lines, frame };
}

const WIDTHS = [200, 130, 116, 100, 80, 62, 50, 40, 30, 20];

describe('StatusFooter の幅ごとの縮退', () => {
  it.each(WIDTHS)('幅 %s でも1行に収まる', (columns) => {
    const { lines } = renderAtWidth(columns);
    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(columns);
  });

  it.each(WIDTHS)('幅 %s: 英語カタログでも1行に収まる', (columns) => {
    const { lines } = renderAtWidth(columns, 'en');
    expect(lines).toHaveLength(1);
    expect(stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(columns);
  });

  it('狭い端末でもモード表示は残る（縮むのはヒントだけ）', () => {
    const { frame } = renderAtWidth(30);
    expect(frame).toContain('自動モード');
  });
});
