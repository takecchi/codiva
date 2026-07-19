/**
 * Strip a single leading ESC (0x1b) so a sequence can be matched with or without
 * it. Terminals sometimes deliver an escape sequence with the leading ESC already
 * consumed by the reader; both `\x1b[…` and `[…` should parse the same.
 */
export function stripLeadingEscape(input: string): string {
  return input.charCodeAt(0) === 27 ? input.slice(1) : input;
}
