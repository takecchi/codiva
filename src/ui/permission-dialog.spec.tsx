import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
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

describe('PermissionDialog — question', () => {
  it('renders the question and options', () => {
    const { lastFrame } = render(
      <PermissionDialog request={question()} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    expect(lastFrame()).toContain('Which language?');
    expect(lastFrame()).toContain('English');
    expect(lastFrame()).toContain('Japanese');
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

  it('toggles with a CSI-u-encoded space', async () => {
    const { stdin, lastFrame } = render(
      <PermissionDialog request={question(true)} onAnswer={noop} onAllow={noop} onDeny={noop} />,
    );
    await flush();
    stdin.write('\x1b[32u'); // CSI-u space → toggle English
    await flush();
    expect(lastFrame()).toContain('❯ [x] English');
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
});
