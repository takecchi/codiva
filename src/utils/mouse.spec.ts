import { describe, expect, it } from 'vitest';
import { enableMouse } from './mouse';

describe('enableMouse', () => {
  it('writes the enable sequence and disables once (idempotent)', () => {
    const writes: string[] = [];
    const disable = enableMouse({ write: (t) => writes.push(t) });
    expect(writes).toEqual(['\x1b[?1002h\x1b[?1006h']);
    disable();
    disable();
    expect(writes).toEqual(['\x1b[?1002h\x1b[?1006h', '\x1b[?1006l\x1b[?1002l\x1b[?1000l']);
  });
});
