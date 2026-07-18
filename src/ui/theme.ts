/**
 * Shared visual language for the TUI. The accent is Claude Code's warm "clay"
 * tone, reused for the prompt caret, banner star, and highlights so the app
 * reads as one surface rather than a grab-bag of ANSI colors.
 */
export const theme = {
  accent: '#d97757', // Claude clay / terracotta — prompt caret, wordmark
  auto: 'green', // ⏵⏵ auto mode indicator
  confirm: 'yellow', // ⏸ confirm mode indicator
  dim: 'gray',
} as const;

/** Glyphs that carry the Claude-Code look. Kept in one place so they stay consistent. */
export const glyph = {
  star: '✻', // header mark
  caret: '❯', // input prompt
  auto: '⏵⏵', // auto-run mode indicator
  confirm: '⏸', // confirm mode indicator
  dot: '·', // hint separator
  bullet: '⏺', // tool-use log line
  branch: '⎿', // tool-result continuation
  attention: '●', // session needs the user
} as const;
