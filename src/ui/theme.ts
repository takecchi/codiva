/**
 * Shared visual language for the TUI. Two *independent* palettes, on purpose:
 *
 *  - `palette` / `theme` — the brand accent colors (identity: caret, wordmark,
 *    logo, focus, dim text). A cool teal family with a charcoal ink and a pink
 *    pop. These carry the codiva "look" and change together.
 *  - `statusColor` — semantic session-state colors, chosen for at-a-glance
 *    clarity, NOT brand harmony. Conventional signal cues (green = done,
 *    red = failed, amber = needs permission, …) so a glance at the list reads
 *    instantly. Keep these vivid and mutually distinct even if they clash with
 *    the accent palette — legibility wins over prettiness here.
 *
 * Everything that paints a color pulls from here so the app reads as one surface
 * instead of a grab-bag of raw ANSI names scattered across components.
 */

/** Brand accent palette — identity, not state. */
export const palette = {
  ink: '#373b3e', // charcoal — deepest neutral (logo shadow, subtle marks)
  mist: '#bec8d1', // light blue-gray — dim / secondary text
  aqua: '#86cecb', // light teal — secondary accent / highlight
  teal: '#137a7f', // deep teal — primary accent (caret, wordmark, focus)
  pink: '#e12885', // magenta — attention pop
} as const;

/**
 * Semantic session-state colors. Optimized for distinguishability at a glance:
 * a "traffic-light" mental model layered with two attention hues (amber vs pink)
 * that separate "let me act for you" from "answer my question".
 */
export const statusColor = {
  creating: '#9aa5b1', // slate — spinning up
  running: '#4c9ed9', // blue — actively working
  awaitingPermission: '#e0a13c', // amber — needs a decision (allow/deny)
  awaitingInput: '#e12885', // pink — needs your answer (matches brand pop)
  completed: '#35c46b', // green — success
  interrupted: '#c9a227', // muted gold — stopped mid-run, resumable (not a clean finish)
  failed: '#f0524b', // red — error
  external: '#a878f0', // violet — handed off to the claude CLI
  archived: '#6b7280', // muted gray — done / inactive
} as const;

export const theme = {
  accent: palette.teal, // primary brand accent — prompt caret, wordmark, focus, selection
  dim: palette.mist, // dim text / inactive
  // Tool-approval mode indicator in the footer. Reuses the signal cues:
  // auto = "go" (green like success), confirm = "pause" (amber like a decision).
  auto: statusColor.completed, // ⏵⏵ auto mode indicator
  confirm: statusColor.awaitingPermission, // ⏸ confirm mode indicator
  // Affirmative / negative for y/n confirm prompts.
  yes: statusColor.completed, // y — go
  no: statusColor.failed, // n — stop
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
