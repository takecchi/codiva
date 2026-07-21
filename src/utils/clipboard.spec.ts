import { describe, expect, it } from 'vitest';
import { buildOsc52, copyToClipboard } from './clipboard';

const ESC = '\x1b';
const BEL = '\x07';

describe('buildOsc52', () => {
  it('wraps base64-encoded UTF-8 in the OSC 52 clipboard sequence', () => {
    const b64 = Buffer.from('hello', 'utf8').toString('base64');
    expect(buildOsc52('hello')).toBe(`${ESC}]52;c;${b64}${BEL}`);
  });

  it('encodes multibyte text as UTF-8', () => {
    const b64 = Buffer.from('こんにちは', 'utf8').toString('base64');
    expect(buildOsc52('こんにちは')).toBe(`${ESC}]52;c;${b64}${BEL}`);
  });

  it('truncates oversized payloads on a UTF-8 boundary (no split code point)', () => {
    // 4-byte emoji; the ~75 KB cap does not align to 4, so the cut lands
    // mid-character and the boundary walk-back must fire.
    const seq = buildOsc52('😀'.repeat(30_000));
    const b64 = seq.slice(seq.indexOf(';c;') + 3, -1); // between ";c;" and BEL
    const bytes = Buffer.from(b64, 'base64');
    // A clean cut: length is a multiple of 4 and it round-trips without a U+FFFD
    // replacement char (a mid-character cut would leave a lone fragment).
    expect(bytes.byteLength % 4).toBe(0);
    expect(bytes.toString('utf8')).not.toContain('�');
  });

  it('wraps for tmux passthrough with doubled ESC and ST terminator', () => {
    const seq = buildOsc52('hi', { tmux: true });
    expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(seq.endsWith(`${ESC}\\`)).toBe(true);
    // The inner OSC's ESC is doubled inside the passthrough.
    expect(seq).toContain(`${ESC}${ESC}]52;c;`);
  });
});

describe('copyToClipboard', () => {
  it('writes an OSC 52 sequence carrying the text to the stream', () => {
    const writes: string[] = [];
    copyToClipboard('abc', { write: (t) => writes.push(t) });
    expect(writes).toHaveLength(1);
    // Contains the base64 payload regardless of tmux wrapping ($TMUX in the env).
    expect(writes[0]).toContain(Buffer.from('abc', 'utf8').toString('base64'));
    expect(writes[0]).toContain(']52;c;');
  });

  it('is a no-op for empty text', () => {
    const writes: string[] = [];
    copyToClipboard('', { write: (t) => writes.push(t) });
    expect(writes).toEqual([]);
  });
});
