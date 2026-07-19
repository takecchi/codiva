import { describe, expect, it } from 'vitest';
import { createModePolicy, type RunMode } from './run-mode';

describe('createModePolicy', () => {
  it('always escalates AskUserQuestion regardless of mode', () => {
    expect(createModePolicy(() => 'auto')('AskUserQuestion', {})).toBe('ask');
    expect(createModePolicy(() => 'confirm')('AskUserQuestion', {})).toBe('ask');
  });

  it('auto-allows other tools in auto mode, asks in confirm mode', () => {
    expect(createModePolicy(() => 'auto')('Bash', {})).toBe('allow');
    expect(createModePolicy(() => 'confirm')('Bash', {})).toBe('ask');
  });

  it('reads the mode live at call time (toggles affect running sessions)', () => {
    let mode: RunMode = 'auto';
    const policy = createModePolicy(() => mode);
    expect(policy('Write', {})).toBe('allow');
    mode = 'confirm';
    expect(policy('Write', {})).toBe('ask');
  });
});
