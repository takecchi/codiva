import { describe, expect, it } from 'vitest';
import { createMouseControl, disableMouseReports, enableMouse } from './mouse';

const ENABLE = '\x1b[?1002h\x1b[?1006h';
// Every mouse mode we could have set — plus the ones an aborted previous run may
// have left behind (a hard kill skips the exit hooks).
const DISABLE = '\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l';

describe('disableMouseReports', () => {
  it('writes the disable sequence on its own (healing a hard-killed previous run)', () => {
    const writes: string[] = [];
    disableMouseReports({ write: (t) => writes.push(t) });
    expect(writes).toEqual([DISABLE]);
  });
});

describe('enableMouse', () => {
  it('writes the enable sequence and disables once (idempotent)', () => {
    const writes: string[] = [];
    const disable = enableMouse({ write: (t) => writes.push(t) });
    expect(writes).toEqual([ENABLE]);
    disable();
    disable();
    expect(writes).toEqual([ENABLE, DISABLE]);
  });
});

describe('createMouseControl', () => {
  it('starts idle; enable then disable writes the sequences once each', () => {
    const writes: string[] = [];
    const control = createMouseControl({ write: (t) => writes.push(t) });
    // No writes until explicitly enabled.
    expect(writes).toEqual([]);
    control.enable();
    expect(writes).toEqual([ENABLE]);
    control.disable();
    expect(writes).toEqual([ENABLE, DISABLE]);
  });

  it('is idempotent: repeated enable/disable do not double-write', () => {
    const writes: string[] = [];
    const control = createMouseControl({ write: (t) => writes.push(t) });
    control.enable();
    control.enable();
    expect(writes).toEqual([ENABLE]);
    control.disable();
    control.disable();
    expect(writes).toEqual([ENABLE, DISABLE]);
  });

  it('can be re-enabled after disabling (detail-view enter/leave cycle)', () => {
    const writes: string[] = [];
    const control = createMouseControl({ write: (t) => writes.push(t) });
    control.enable();
    control.disable();
    control.enable();
    control.disable();
    expect(writes).toEqual([ENABLE, DISABLE, ENABLE, DISABLE]);
  });
});
