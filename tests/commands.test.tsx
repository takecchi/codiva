import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { App } from '@/app';
import { messages } from '@/core/i18n';
import { flush, makeManager } from './helpers';

// Feature test for slash commands driven through the whole App. Pure parsing is
// unit-tested in src/core/commands.spec.ts; this checks the UI wiring: the
// palette, /help overlay, /exit, and the unknown-command error.

describe('slash commands', () => {
  it('shows the command palette while typing a leading slash', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(messages.ja.command.paletteTitle);
    expect(frame).toContain('/help');
    expect(frame).toContain('/exit');
  });

  it('filters the palette by the typed prefix', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/ex');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/exit');
    expect(frame).not.toContain('/help');
  });

  it('does not create a session when a command is submitted', async () => {
    const manager = makeManager();
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('/help opens the help overlay listing every command', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain(messages.ja.command.helpTitle);
    expect(frame).toContain(messages.ja.command.help); // /help description
    expect(frame).toContain(messages.ja.command.exit); // /exit description
  });

  it('/exit tears down the manager and exits', async () => {
    const manager = makeManager();
    const dispose = vi.spyOn(manager, 'dispose');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/exit');
    await flush();
    stdin.write('\r');
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('/prompt opens the repo-prompt editor and saves the edited instructions', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/prompt');
    await flush();
    stdin.write('\r'); // run the command → opens the editor
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.prompt.title);
    stdin.write('run tests then open a PR');
    await flush();
    stdin.write('\r'); // Enter saves
    await flush();
    expect(manager.getRepoPrompt()).toBe('run tests then open a PR');
    // Editor closed — the title is gone and no session was created.
    expect(lastFrame() ?? '').not.toContain(messages.ja.prompt.title);
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('/prompt editor cancels on Esc without changing the instructions', async () => {
    const manager = makeManager();
    manager.setRepoPrompt('keep me');
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/prompt');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('\x1b'); // Esc cancels
    await flush();
    expect(manager.getRepoPrompt()).toBe('keep me');
    expect(lastFrame() ?? '').not.toContain(messages.ja.prompt.title);
  });

  it('lists /clear in the command palette', async () => {
    const { stdin, lastFrame } = render(<App manager={makeManager()} />);
    stdin.write('/clear');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('/clear');
    expect(frame).toContain(messages.ja.command.clear); // description shown
  });

  it('/clear clears the session list and creates no session', async () => {
    const manager = makeManager();
    const clear = vi.spyOn(manager, 'clear');
    const { stdin } = render(<App manager={manager} />);
    stdin.write('/clear');
    await flush();
    stdin.write('\r');
    await flush();
    expect(clear).toHaveBeenCalledOnce();
    expect(manager.getSnapshot()).toHaveLength(0);
  });

  it('reports an unknown command as an error', async () => {
    const manager = makeManager();
    const { stdin, lastFrame } = render(<App manager={manager} />);
    stdin.write('/frobnicate');
    await flush();
    stdin.write('\r');
    await flush();
    expect(lastFrame() ?? '').toContain(messages.ja.command.unknown('frobnicate'));
    expect(manager.getSnapshot()).toHaveLength(0);
  });
});
