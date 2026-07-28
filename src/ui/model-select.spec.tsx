import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '@/core';
import { ModelSelect } from '@/ui/model-select';

const flush = () => new Promise((r) => setTimeout(r, 30));
const noop = () => {};
// Real ANSI escape sequences (leading ESC byte) — bare "[A" is not an arrow key.
const UP = '[A';
const DOWN = '[B';
const ESC = '';

/**
 * Stand-in for Claude Code's catalog, shaped like real `supportedModels()` output
 * (alias `value` + `resolvedModel`, English SDK display strings).
 */
const MODELS: readonly ModelOption[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-8[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context \u00b7 Best for everyday, complex tasks',
  },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-4-8[1m]', displayName: 'Opus' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];

describe('ModelSelect', () => {
  it('renders the title and every model the catalog reports', () => {
    const { lastFrame } = render(
      <ModelSelect current={undefined} models={MODELS} onSelect={noop} onCancel={noop} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('モデルを選択');
    // Model names come from the SDK verbatim, but the "CLI default" row is
    // codiva's own concept and stays translated (see .claude/rules/i18n.md).
    expect(frame).toContain('デフォルト（推奨）');
    expect(frame).not.toContain('Default (recommended)');
    expect(frame).toContain('Opus');
    expect(frame).toContain('Sonnet');
    expect(frame).toContain('Haiku');
  });

  it('renders the SDK description verbatim', () => {
    const { lastFrame } = render(
      <ModelSelect current={undefined} models={MODELS} onSelect={noop} onCancel={noop} />,
    );
    expect(lastFrame() ?? '').toContain('Best for everyday, complex tasks');
  });

  it('shows only models the catalog offers (no hardcoded rows)', () => {
    const { lastFrame } = render(
      <ModelSelect
        current={undefined}
        models={[{ value: 'sonnet', displayName: 'Sonnet' }]}
        onSelect={noop}
        onCancel={noop}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sonnet');
    expect(frame).not.toContain('Opus');
    expect(frame).not.toContain('Haiku');
  });

  it('marks the current model with a check', () => {
    const { lastFrame } = render(
      <ModelSelect current="sonnet" models={MODELS} onSelect={noop} onCancel={noop} />,
    );
    const sonnetLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('Sonnet'));
    expect(sonnetLine).toContain('✔');
  });

  it('marks the row covering a persisted explicit model id', () => {
    // Config holds the full id; the catalog only offers the alias row.
    const { lastFrame } = render(
      <ModelSelect current="claude-sonnet-5" models={MODELS} onSelect={noop} onCancel={noop} />,
    );
    const sonnetLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('Sonnet'));
    expect(sonnetLine).toContain('✔');
  });

  it('selects the highlighted model on Enter', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current="opus[1m]" models={MODELS} onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Opus (the current model). Enter selects it.
    stdin.write('\r');
    await flush();
    expect(onSelect).toHaveBeenCalledWith('opus[1m]');
  });

  it('moves the cursor and selects the model under it', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current={undefined} models={MODELS} onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Default (index 0). Down -> Opus.
    stdin.write(DOWN);
    await flush();
    stdin.write('\r');
    await flush();
    expect(onSelect).toHaveBeenCalledWith('opus[1m]');
  });

  it('returns undefined when the default choice is selected', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelSelect current="opus[1m]" models={MODELS} onSelect={onSelect} onCancel={noop} />,
    );
    // Cursor starts on Opus (index 1). Up -> Default (index 0).
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
      <ModelSelect current={undefined} models={MODELS} onSelect={onSelect} onCancel={onCancel} />,
    );
    stdin.write(ESC);
    await flush();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe('while the catalog is still loading', () => {
    it('shows the loading line instead of a list', () => {
      const { lastFrame } = render(
        <ModelSelect current={undefined} models={undefined} onSelect={noop} onCancel={noop} />,
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('モデル一覧を取得中');
      expect(frame).not.toContain('Sonnet');
    });

    it('does not select anything on Enter', async () => {
      const onSelect = vi.fn();
      const { stdin } = render(
        <ModelSelect current={undefined} models={undefined} onSelect={onSelect} onCancel={noop} />,
      );
      stdin.write('\r');
      await flush();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('still cancels on Esc', async () => {
      const onCancel = vi.fn();
      const { stdin } = render(
        <ModelSelect current={undefined} models={undefined} onSelect={noop} onCancel={onCancel} />,
      );
      stdin.write(ESC);
      await flush();
      expect(onCancel).toHaveBeenCalled();
    });
  });

  // The dialog can be opened within the ~0.3-2s the startup fetch takes, i.e.
  // before the rows exist. The cursor must re-derive once they land, otherwise
  // Enter would confirm row 0 ("Default") and silently change the user's model.
  describe('when the catalog arrives after the dialog is already open', () => {
    it('moves the cursor onto the current model', () => {
      const { lastFrame, rerender } = render(
        <ModelSelect current="sonnet" models={undefined} onSelect={noop} onCancel={noop} />,
      );
      rerender(<ModelSelect current="sonnet" models={MODELS} onSelect={noop} onCancel={noop} />);
      const caretLine = (lastFrame() ?? '').split('\n').find((l) => l.includes('❯'));
      expect(caretLine).toContain('Sonnet');
    });

    it('confirms the current model on Enter, not the default row', async () => {
      const onSelect = vi.fn();
      const { rerender, stdin } = render(
        <ModelSelect current="sonnet" models={undefined} onSelect={onSelect} onCancel={noop} />,
      );
      rerender(
        <ModelSelect current="sonnet" models={MODELS} onSelect={onSelect} onCancel={noop} />,
      );
      stdin.write('\r');
      await flush();
      expect(onSelect).toHaveBeenCalledWith('sonnet');
    });

    it('keeps the cursor in range if the catalog shrinks after a move', async () => {
      const onSelect = vi.fn();
      const { rerender, stdin } = render(
        <ModelSelect current={undefined} models={MODELS} onSelect={onSelect} onCancel={noop} />,
      );
      stdin.write(DOWN);
      await flush();
      stdin.write(DOWN); // cursor at index 2 of 4
      await flush();
      rerender(
        <ModelSelect
          current={undefined}
          models={[{ value: 'sonnet', displayName: 'Sonnet' }]}
          onSelect={onSelect}
          onCancel={noop}
        />,
      );
      stdin.write('\r');
      await flush();
      expect(onSelect).toHaveBeenCalledWith('sonnet');
    });
  });
});
