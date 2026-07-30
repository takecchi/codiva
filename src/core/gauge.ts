/**
 * Cell arithmetic for the fixed-width usage bar in the status footer. Pure: this
 * returns how many cells to paint, the glyphs come from `ui/theme.ts` (no raw
 * symbols in core, no arithmetic in the UI).
 */

/** How many cells of a `width`-wide bar are filled vs empty. */
export interface GaugeCells {
  filled: number;
  empty: number;
}

/**
 * Split a `width`-wide bar for `percent` (0–100, clamped).
 *
 * A non-zero percentage always paints at least one cell: rounding 1% of a 10-cell
 * bar down to an empty bar would read as "nothing used yet", which is exactly the
 * misreading the bar exists to prevent. 100% fills every cell.
 */
export function gaugeCells(percent: number, width: number): GaugeCells {
  const cells = Math.max(0, Math.trunc(width));
  if (cells === 0) {
    return { filled: 0, empty: 0 };
  }
  const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const scaled = Math.round((pct / 100) * cells);
  const filled = pct > 0 ? Math.max(1, Math.min(cells, scaled)) : 0;
  return { filled, empty: cells - filled };
}
