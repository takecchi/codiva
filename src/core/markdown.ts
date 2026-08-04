import { marked, type Token, type Tokens } from 'marked';
import { openableUrl } from './url';

/**
 * Markdown rendering for assistant log text. The AI replies in Markdown, so
 * showing it raw (`**bold**`, `# heading`, fenced code fences) is noisy. This
 * module turns Markdown into *styled logical lines* — the terminal-native
 * representation the detail-view log understands.
 *
 * Pure and I/O-free (see architecture.md): it only depends on `marked`'s lexer
 * (a pure tokenizer). It does NOT wrap to a terminal width — that is layout,
 * handled by `wrapRichLine` in `scroll.ts` (which owns the CJK-aware measuring).
 * Here we emit unwrapped logical lines; the UI maps each span's `tone` to a
 * concrete theme color so `core` stays free of ANSI/theme concerns.
 */

/**
 * Semantic color role for a span. Kept abstract (not a concrete ANSI/hex color)
 * so the palette lives in the UI theme (`markdownColor`) and `core` never names
 * a color. `undefined` tone = default terminal foreground.
 */
export type MarkdownTone = 'heading' | 'code' | 'link' | 'quote' | 'marker';

/** A styled run of text within one logical line. `text` never contains newlines. */
export interface RichSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  tone?: MarkdownTone;
  /**
   * リンクの飛び先。`[label](url)` は見えているのが label なので、**表示テキストから
   * URL を復元できない** — だからスパンに載せて運ぶ。`http(s)` 以外（`mailto:` /
   * 相対リンク）は載せない（`openableUrl` で絞る）ので、値があれば必ず開ける。
   * 実際の当たり判定用の範囲は `spanLinks` がここから組み立てる。
   */
  link?: string;
}

/** One logical (pre-wrap) line of rendered Markdown. Empty array = a blank line. */
export type RichLine = RichSpan[];

/** Bullet for unordered list items. */
const BULLET = '• ';
/** Prefix drawn on each wrapped line of a blockquote. */
const QUOTE_BAR = '│ ';
/** Fixed-width rule for a thematic break (`---`). */
const RULE = '────────';

/**
 * Flatten inline tokens (strong/em/code/link/…) into styled spans, inheriting
 * `base` styling and layering each token's own style on top. Emits a `\n` span
 * for hard breaks (`<br>`); block splitting on those happens in `spansToLines`.
 */
function inlineSpans(tokens: readonly Token[] | undefined, base: RichSpan): RichSpan[] {
  if (!tokens) {
    return [];
  }
  const out: RichSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        // An inline `text` token may itself hold nested markup tokens.
        if (t.tokens && t.tokens.length > 0) {
          out.push(...inlineSpans(t.tokens, base));
        } else {
          out.push({ ...base, text: t.text });
        }
        break;
      }
      case 'strong':
        out.push(...inlineSpans((token as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case 'em':
        out.push(...inlineSpans((token as Tokens.Em).tokens, { ...base, italic: true }));
        break;
      case 'del':
        out.push(...inlineSpans((token as Tokens.Del).tokens, { ...base, strikethrough: true }));
        break;
      case 'codespan':
        out.push({ ...base, tone: 'code', text: (token as Tokens.Codespan).text });
        break;
      case 'link': {
        const lk = token as Tokens.Link;
        out.push(
          ...inlineSpans(lk.tokens, {
            ...base,
            underline: true,
            tone: 'link',
            link: openableUrl(lk.href),
          }),
        );
        break;
      }
      case 'image': {
        const im = token as Tokens.Image;
        out.push({
          ...base,
          underline: true,
          tone: 'link',
          link: openableUrl(im.href),
          text: im.text || im.href,
        });
        break;
      }
      case 'br':
        out.push({ ...base, text: '\n' });
        break;
      case 'escape':
        out.push({ ...base, text: (token as Tokens.Escape).text });
        break;
      case 'html':
        out.push({ ...base, text: (token as Tokens.HTML).text });
        break;
      default: {
        // Unknown inline token — fall back to its literal text/raw.
        const generic = token as { text?: string; raw?: string };
        const text = generic.text ?? generic.raw;
        if (text) {
          out.push({ ...base, text });
        }
      }
    }
  }
  return out;
}

/** Split spans carrying embedded `\n` (hard breaks) into separate logical lines. */
function spansToLines(spans: readonly RichSpan[]): RichLine[] {
  const lines: RichLine[] = [];
  let current: RichLine = [];
  lines.push(current);
  for (const span of spans) {
    const parts = span.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        current = [];
        lines.push(current);
      }
      if (part.length > 0) {
        current.push({ ...span, text: part });
      }
    });
  }
  return lines;
}

/** Drop leading/trailing blank lines and collapse runs of blanks into a single one. */
function tidy(lines: RichLine[]): RichLine[] {
  const out: RichLine[] = [];
  for (const line of lines) {
    const blank = line.length === 0;
    const prevBlank = out.length === 0 || out[out.length - 1]?.length === 0;
    if (blank && prevBlank) {
      continue; // skip leading blanks and collapse consecutive blanks
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]?.length === 0) {
    out.pop();
  }
  return out;
}

/** Prefix every line of `lines` with `lead` (first line) / `indent` (continuations). */
function prefixLines(lines: RichLine[], lead: RichSpan, indent: RichSpan): RichLine[] {
  const rows = lines.length > 0 ? lines : [[]];
  return rows.map((line, i) => [i === 0 ? lead : indent, ...line]);
}

function headingLines(token: Tokens.Heading): RichLine[] {
  return spansToLines(inlineSpans(token.tokens, { text: '', bold: true, tone: 'heading' }));
}

function codeLines(token: Tokens.Code): RichLine[] {
  return token.text.split('\n').map((line) => [{ text: line, tone: 'code', dim: true }]);
}

function blockquoteLines(token: Tokens.Blockquote): RichLine[] {
  return blockLines(token.tokens).map((line) => [
    { text: QUOTE_BAR, tone: 'quote' } as RichSpan,
    ...line,
  ]);
}

function listLines(token: Tokens.List): RichLine[] {
  const out: RichLine[] = [];
  let n = typeof token.start === 'number' ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${n}. ` : BULLET;
    if (token.ordered) {
      n += 1;
    }
    const box = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
    const lead = `${marker}${box}`;
    const inner = tidy(blockLines(item.tokens));
    for (const line of prefixLines(
      inner,
      { text: lead, tone: 'marker' },
      { text: ' '.repeat(lead.length) },
    )) {
      out.push(line);
    }
  }
  return out;
}

/** Join cell span-lists with a dim separator into one table row line. */
function tableRow(cells: RichSpan[][]): RichLine {
  const out: RichLine = [];
  cells.forEach((cell, i) => {
    if (i > 0) {
      out.push({ text: ' │ ', tone: 'marker' });
    }
    out.push(...cell);
  });
  return out;
}

function tableLines(token: Tokens.Table): RichLine[] {
  const out: RichLine[] = [];
  out.push(tableRow(token.header.map((c) => inlineSpans(c.tokens, { text: '', bold: true }))));
  for (const row of token.rows) {
    out.push(tableRow(row.map((c) => inlineSpans(c.tokens, { text: '' }))));
  }
  return out;
}

/** Render a list of block-level tokens into logical lines (recursion entry point). */
function blockLines(tokens: readonly Token[]): RichLine[] {
  const out: RichLine[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        out.push([]);
        break;
      case 'heading':
        out.push(...headingLines(token as Tokens.Heading));
        break;
      case 'paragraph':
        out.push(...spansToLines(inlineSpans((token as Tokens.Paragraph).tokens, { text: '' })));
        break;
      case 'text': {
        // Block-level text (loose list items, plain lines): may hold inline tokens.
        const t = token as Tokens.Text;
        const spans = t.tokens ? inlineSpans(t.tokens, { text: '' }) : [{ text: t.text }];
        out.push(...spansToLines(spans));
        break;
      }
      case 'code':
        out.push(...codeLines(token as Tokens.Code));
        break;
      case 'blockquote':
        out.push(...blockquoteLines(token as Tokens.Blockquote));
        break;
      case 'list':
        out.push(...listLines(token as Tokens.List));
        break;
      case 'table':
        out.push(...tableLines(token as Tokens.Table));
        break;
      case 'hr':
        out.push([{ text: RULE, tone: 'marker', dim: true }]);
        break;
      case 'html':
        for (const line of (token as Tokens.HTML).text.replace(/\n$/, '').split('\n')) {
          out.push([{ text: line }]);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Render Markdown source into styled logical lines. Never throws for malformed
 * input in practice (the lexer is permissive), but callers should still guard —
 * see `logLines` in `scroll.ts`, which falls back to plain wrapping on error.
 */
export function renderMarkdown(text: string): RichLine[] {
  return tidy(blockLines(marked.lexer(text)));
}
