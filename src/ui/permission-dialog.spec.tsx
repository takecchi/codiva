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
