import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelect } from '@/ui/model-select';

const flush = () => new Promise((r) => setTimeout(r, 30));
const noop = () => {};
// Real ANSI escape sequences (leading ESC byte) — bare "[A" is not an arrow key.
const UP = '[A';
const DOWN = '[B';
const ESC = '';

describe('ModelSelect', () => {
  it('renders the title and every model choice', () => {
    const { lastFrame } = render(
      <ModelSelect current={undefined} onSelect={noop} onCancel={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('モデルを選択');
    expect(frame).toContain('デフォルト');
    expect(frame).toContain('Opus');
    expect(frame).toContain('Fable');
    expect(frame).toContain('Sonnet');
    expect(frame).toContain('Haiku');
  });

  it('marks the current model with a check', () => {
    const { lastFrame } = render(
      <ModelSelect current="claude-sonnet-5" onSelect={noop} onCancel={noop} />,
    );
    // The Sonnet row carries the ✔ marker.
    const sonnetLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('Sonnet'));
    expect(sonnetLine).toContain('✔');
  });

  it('selects the highlighted model on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current="claude-opus-4-8" onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Opus (the current model). Enter selects it.
    stdin.write('\r');
    await flush();
    expect(onSelect).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('moves the cursor and selects the model under it', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current={undefined} onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Default (index 0). Down → Opus.
    stdin.write(DOWN);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onSelect).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('returns undefined when the default choice is selected', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current="claude-opus-4-8" onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Opus (index 1). Up → Default (index 0).
    stdin.write(UP);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('cancels on Esc without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <ModelSelect current={undefined} onSelect={onSelect} onCancel={onCancel} />,
    );
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
