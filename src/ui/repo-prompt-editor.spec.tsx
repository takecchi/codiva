import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { RepoPromptEditor } from '@/ui/repo-prompt-editor';

const flush = () => new Promise((r) => setTimeout(r, 30));
const noop = () => {};
const ESC = '\x1b';
const ENTER = '\r';

describe('RepoPromptEditor', () => {
  it('renders the title, seeded content, and the key hint', () => {
    const { lastFrame } = render(
      <RepoPromptEditor initial="Open a PR when done" onSave={noop} onCancel={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('.codiva/prompt.md');
    expect(frame).toContain('Open a PR when done');
    expect(frame).toContain('Enter: 保存');
  });

  it('shows the placeholder when opened with no prompt', () => {
    const { lastFrame } = render(
      <RepoPromptEditor initial={undefined} onSave={noop} onCancel={noop} />,
    );
    expect(lastFrame() ?? '').toContain('作業が終わったら');
  });

  it('saves the seeded content on Enter (view → save)', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial="Open a PR when done" onSave={onSave} onCancel={noop} />,
    );
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('Open a PR when done');
  });

  it('appends typed text and saves it on Enter', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial={undefined} onSave={onSave} onCancel={noop} />,
    );
    stdin.write('run tests');
    await flush();
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('run tests');
  });

  it('saves an empty string (clear) when Enter is pressed on an empty editor', async () => {
    const onSave = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial={undefined} onSave={onSave} onCancel={noop} />,
    );
    stdin.write(ENTER);
    await flush();
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('cancels on Esc without saving', async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <RepoPromptEditor initial="keep me" onSave={onSave} onCancel={onCancel} />,
    );
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
