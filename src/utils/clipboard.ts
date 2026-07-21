import type { WritableLike } from './terminal-mode';

/**
 * Write text to the system clipboard with an OSC 52 escape sequence. Unlike
 * `pbcopy`/`xclip`, OSC 52 is interpreted by the *terminal emulator*, so it works
 * transparently over SSH / inside containers where no clipboard binary exists —
 * which is why TUIs (Claude Code, gemini-cli, …) prefer it. The terminal must
 * allow clipboard writes (iTerm2 needs it enabled in prefs; tmux needs
 * `set-clipboard on`).
 */

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

/**
 * OSC 52 caps the whole sequence around 100 KB and several terminals silently
 * drop larger writes, so bound the raw payload. Composer text is tiny in
 * practice; this only guards against pathological pastes.
 */
const MAX_BYTES = 74_994;

/**
 * Truncate a UTF-8 buffer to at most `maxBytes` without splitting a multi-byte
 * code point. A UTF-8 continuation byte matches `10xxxxxx`; if the byte *at* the
 * cut point is one, the cut lands inside a character, so back up until it sits on
 * a character boundary (a lead or ASCII byte). Cutting mid-character would base64
 * a lone fragment and render as mojibake in the clipboard.
 */
function safeUtf8Truncate(buf: Buffer, maxBytes: number): Buffer {
  if (buf.byteLength <= maxBytes) {
    return buf;
  }
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return buf.subarray(0, end);
}

/**
 * When running inside tmux, an OSC sequence must be wrapped in a DCS passthrough
 * (`ESC P tmux; … ESC \`) with every inner ESC doubled, or tmux swallows it
 * instead of forwarding it to the outer terminal. Requires `allow-passthrough on`
 * (default since tmux 3.3).
 */
function wrapForTmux(seq: string): string {
  return `${ESC}Ptmux;${seq.split(ESC).join(`${ESC}${ESC}`)}${ST}`;
}

/**
 * Build the OSC 52 "set clipboard" sequence for `text`. `c` targets the CLIPBOARD
 * selection (the usual Cmd/Ctrl+V buffer). Pure (no I/O) so it can be unit tested.
 */
export function buildOsc52(text: string, opts: { tmux?: boolean } = {}): string {
  const payload = safeUtf8Truncate(Buffer.from(text, 'utf8'), MAX_BYTES).toString('base64');
  const seq = `${ESC}]52;c;${payload}${BEL}`;
  return opts.tmux ? wrapForTmux(seq) : seq;
}

/**
 * Copy `text` to the system clipboard via OSC 52. No-op for empty text. tmux is
 * detected from `$TMUX` so the sequence is wrapped for passthrough. Fire-and-
 * forget: if the terminal ignores OSC 52 there is nothing to fall back to here
 * (the app still keeps working), we simply don't get a clipboard write.
 */
export function copyToClipboard(text: string, stream: WritableLike = process.stdout): void {
  if (text.length === 0) {
    return;
  }
  stream.write(buildOsc52(text, { tmux: Boolean(process.env.TMUX) }));
}
