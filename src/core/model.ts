/**
 * Model-id display helpers. The SDK/CLI reports the resolved model as a raw id
 * (e.g. `claude-opus-4-8`); this turns it into a short human label for the TUI.
 * Pure — no I/O.
 */

/** Known Claude model families, longest-first so `sonnet` wins over a bare match. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * Turn a raw model id into a short display label.
 *
 * Handles both id shapes the CLI emits:
 *   - current: `claude-opus-4-8`, `claude-haiku-4-5` → `Opus 4.8`, `Haiku 4.5`
 *   - dated:   `claude-3-5-sonnet-20241022`          → `Sonnet 3.5`
 *
 * A trailing context tag like `[1m]` is stripped before parsing. Aliases with no
 * version (`sonnet`, `opus`) become the Title-cased family (`Sonnet`, `Opus`).
 * Unrecognized values are returned as-is; `undefined`/empty stay `undefined` so
 * callers can render nothing.
 */
export function formatModel(model: string | undefined): string | undefined {
  const id = model?.trim();
  if (!id) {
    return undefined;
  }
  // Drop a context-window tag (`claude-sonnet-4-5[1m]`) before matching.
  const base = id.replace(/\[[^\]]*\]/g, '').toLowerCase();
  const family = FAMILIES.find((f) => base.includes(f));
  if (!family) {
    return id; // unknown id — show verbatim rather than hide it
  }
  const label = family.charAt(0).toUpperCase() + family.slice(1);
  // Version = the short numeric groups (major/minor). Skip date-like segments
  // (`20241022`) by keeping only 1–2 digit groups.
  const version = base
    .split(/[^0-9]+/)
    .filter((n) => n.length > 0 && n.length <= 2)
    .slice(0, 2)
    .join('.');
  return version.length > 0 ? `${label} ${version}` : label;
}
