/**
 * Pure hit-testing for the session list's mouse handling. The UI measures box
 * positions (Ink yoga layout) and passes plain cell coordinates in; these
 * functions never touch Ink so they stay unit-testable.
 */

/**
 * The visible-window row offset (0-based) for a click at terminal row `y`, or
 * undefined when the click falls outside the rendered rows. `rowsTop` is the rows
 * box's top edge; `showAbove` accounts for the leading "N more above" indicator
 * line; `visibleCount` is how many session rows are currently drawn. Add the
 * window's `start` index to map the result to a session index.
 */
export function rowLineAtPoint(
  y: number,
  rowsTop: number,
  showAbove: boolean,
  visibleCount: number,
): number | undefined {
  const rowLine = y - rowsTop - (showAbove ? 1 : 0);
  return rowLine >= 0 && rowLine < visibleCount ? rowLine : undefined;
}

/**
 * Display width of the trailing PR cell when every row shows at most one PR
 * (`⑂ #1234`). It's the row's last column, so it sits flush at the right edge
 * regardless of the responsive title/branch widths — which is what lets mouse
 * hit-testing locate it from the terminal width alone.
 */
export const PR_CELL_WIDTH = 10;

/**
 * Widened PR cell for when some row has more than one PR (`⑂ #1234 +2`). The extra
 * columns are taken from the flexible title/branch columns, and only while a
 * multi-PR session is on screen: a fixed wide cell would steal width from every
 * list, and a too-narrow one would clip the `+n` that says "there is more here".
 */
export const PR_CELL_WIDTH_MULTI = 14;

/** Which of the two widths the list should use (and hit-test against) right now. */
export function prCellWidth(anyMultiPr: boolean): number {
  return anyMultiPr ? PR_CELL_WIDTH_MULTI : PR_CELL_WIDTH;
}

/**
 * Whether a click at column `x` lands inside the trailing, right-anchored `#<n>`
 * PR cell. The cell hugs the right edge, so its left column is derived from the
 * terminal width, the row box's (symmetric) left padding, and the cell width.
 */
export function isPrCellHit(
  x: number,
  columns: number,
  rowsLeft: number,
  cellWidth: number,
): boolean {
  const cellLeft = columns - rowsLeft - cellWidth;
  return x >= cellLeft && x < cellLeft + cellWidth;
}
