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

/**
 * GitHub の issue / PR の URL。タイトル欄では長すぎる（それだけで 45 文字前後あり、
 * 50 文字の枠をほぼ使い切って肝心の本文が `…` に消える）一方、**人が見分けたいのは
 * リポジトリ名と番号だけ**なので、そこへ畳む。他ホストの URL は形が読めないので触らない。
 */
const GITHUB_ISSUE_URL =
  /https?:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:issues|pull)\/(\d+)\b\S*/gi;

/**
 * Human-facing session title: single-line, trimmed, length-limited.
 *
 * 「リンク 1 本 + ひとこと」の指示（`https://github.com/o/r/issues/139 こちらの対応を
 * お願いします。`）は実際によく来るが、そこでは**要約を生成しない**（材料がリンクの
 * 先にあり、要約器はそれを読めない → `core/title-prompt.ts`）。つまりこの関数の出力が
 * そのままタイトルとして残るので、URL を畳んで読めるようにしておく。
 */
export function makeTitle(prompt: string): string {
  const normalized = prompt
    .replace(GITHUB_ISSUE_URL, (_url, repo: string, number: string) => `${repo}#${number}`)
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= MAX_TITLE) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TITLE)}…`;
}
