const MAX_SLUG = 40;
const MAX_TITLE = 50;

/**
 * Turn a prompt into an ASCII kebab-case slug safe for a branch/dir name.
 * Non-ASCII (e.g. Japanese) text has no safe romanization here, so such
 * prompts fall back to "task" — uniqueSlug then disambiguates with a counter.
 */
export function makeSlug(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'task';
}

/** Append -2, -3, ... until the slug is not already taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Human-facing session title: single-line, trimmed, length-limited. */
export function makeTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_TITLE) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TITLE)}…`;
}
