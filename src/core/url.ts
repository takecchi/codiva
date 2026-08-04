/**
 * URL の検出と、行の中のリンク範囲の表現（純粋）。
 *
 * 詳細ビューのログは「クリックで URL を開ける」ようにするため、行ごとに
 * {@link LinkRange} を持つ（`DisplayLine.links`）。範囲で持つ理由は 2 つ:
 *
 * 1. **表示テキストと開く先が違うことがある**。Markdown の `[label](url)` は
 *    見えているのが label なので、テキストから URL を復元できない。
 * 2. **折り返しで URL が 2 行に割れても両方の行から開ける**。行ごとに「この
 *    範囲は元の URL 全体を指す」と持てば、半分だけの文字列を解析し直さずに済む。
 *
 * 当たり判定（`logLinkAt`）と描画（`ui/log-line.tsx`）は同じ範囲を通す。
 */

/**
 * 1 行のテキスト内のリンク範囲。`from`/`to` は**その行のテキストに対する文字
 * オフセット**（`[from, to)`。`DisplayLine.text` と同じ単位＝UTF-16）で、
 * kind の prefix / 継続行の字下げを含んだ位置。`url` は開く先。
 */
export interface LinkRange {
  readonly from: number;
  readonly to: number;
  readonly url: string;
}

/**
 * 裸の URL を拾う正規表現。空白と、URL に現れない引用・山括弧で止める。制御文字も
 * 除外する — ツール出力にはエスケープ列の断片が混ざり得るので、それを URL の一部と
 * して端末へ返さないため。閉じ括弧は含めて拾い、あとで {@link trimTrailing} が
 * 釣り合いを見て落とす（`.../Foo_(bar)` を壊さないため）。
 */
const BARE_URL = /\bhttps?:\/\/[^\s<>"']+/g;

/** 文末の句読点・閉じ括弧。URL の一部ではないことが多いので末尾から削る。 */
const TRAILING = new Set([
  '.',
  ',',
  ';',
  ':',
  '!',
  '?',
  '"',
  "'",
  '\u0060',
  '*',
  '_',
  '~',
  ')',
  ']',
  '}',
  '>',
  '、',
  '。',
  '，',
  '．',
  '）',
  '】',
  '」',
  '』',
  '？',
  '！',
]);

/**
 * URL の長さ上限。tmux は OSC 8 の URI を 1024 バイトで打ち切る（`hyperlinks.c`）ので、
 * それを超えるものはハイパーリンクにしない。ブラウザで開く側の実用上の上限も兼ねる。
 */
const MAX_URL_CHARS = 1024;

/**
 * 制御文字（C0 / DEL）を含むか。ツール出力にはエスケープ列の断片が混ざり得るので、
 * それを URL の一部として端末やブラウザへ渡さないために弾く。正規表現ではなく
 * コードポイントで見る（ソースに生の制御文字を書かないため）。
 */
function hasControlChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) {
    if (c === ch) {
      n += 1;
    }
  }
  return n;
}

/**
 * 末尾の句読点を削る。ただし**括弧が釣り合っているぶんは URL の一部**として残す
 * （`https://ja.wikipedia.org/wiki/Foo_(bar)` の `)` を落とさない）。
 */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] ?? '';
    if (!TRAILING.has(ch)) {
      break;
    }
    if (ch === ')') {
      const head = url.slice(0, end);
      if (countChar(head, '(') >= countChar(head, ')')) {
        break; // 対応する '(' がある = URL の一部
      }
    }
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * ブラウザで開いてよい URL か。**http(s) のみ**を通す（`file:` / `javascript:` /
 * `mailto:` は開かない）。ホスト部が空のものと、長すぎるものも弾く。
 */
export function isOpenableUrl(url: string): boolean {
  if (url.length > MAX_URL_CHARS || hasControlChar(url)) {
    return false;
  }
  const m = /^https?:\/\/([^\s/?#]+)/.exec(url);
  return m !== null && (m[1]?.length ?? 0) > 0;
}

/** 開ける URL ならそれ自身、そうでなければ undefined（Markdown の href の絞り込み用）。 */
export function openableUrl(url: string | undefined): string | undefined {
  return url !== undefined && isOpenableUrl(url) ? url : undefined;
}

/**
 * `text` の中の裸の URL を検出する。返る範囲は文書順で重複しない。
 *
 * 検出は表示テキスト基準なので、Markdown の `[label](url)` はここでは拾えない
 * （あちらは `RichSpan.link` として `core/markdown.ts` が運ぶ）。
 */
export function detectUrls(text: string): LinkRange[] {
  // ログの大半に URL は無い。正規表現を回す前に安価に落とす（logLines は毎フレーム走る）。
  if (!text.includes('://')) {
    return [];
  }
  const out: LinkRange[] = [];
  BARE_URL.lastIndex = 0;
  for (let m = BARE_URL.exec(text); m !== null; m = BARE_URL.exec(text)) {
    const url = trimTrailing(m[0]);
    if (url.length > 0 && isOpenableUrl(url)) {
      out.push({ from: m.index, to: m.index + url.length, url });
    }
  }
  return out;
}

/** `index` の文字を含むリンク範囲（無ければ undefined）。 */
function rangeAt(links: readonly LinkRange[] | undefined, index: number): LinkRange | undefined {
  if (!links) {
    return undefined;
  }
  for (const link of links) {
    if (index >= link.from && index < link.to) {
      return link;
    }
  }
  return undefined;
}

/** `index` の文字に掛かっているリンクの URL（無ければ undefined）。 */
export function linkAt(links: readonly LinkRange[] | undefined, index: number): string | undefined {
  return rangeAt(links, index)?.url;
}

/**
 * `[start, end)` に掛かるリンクを切り出し、`start` が `base` に来るよう再基準化する。
 * 論理行に対して検出した範囲を、折り返し後の 1 行（先頭に prefix / 字下げが付く）の
 * 座標へ移すのに使う。URL 自体は切らないので、割れた行のどちらからでも全体が開ける。
 */
export function linksInSlice(
  links: readonly LinkRange[],
  start: number,
  end: number,
  base = 0,
): LinkRange[] {
  const out: LinkRange[] = [];
  for (const link of links) {
    const from = Math.max(link.from, start);
    const to = Math.min(link.to, end);
    if (to > from) {
      out.push({ from: from - start + base, to: to - start + base, url: link.url });
    }
  }
  return out;
}

/**
 * `primary` を優先して 2 つのリンク集合を統合する。重なる `extra` は捨てる
 * （Markdown の href が付いている範囲に、裸 URL の検出結果を二重に載せない）。
 */
export function mergeLinks(
  primary: readonly LinkRange[],
  extra: readonly LinkRange[],
): LinkRange[] {
  const out = [...primary];
  for (const e of extra) {
    if (!primary.some((p) => e.from < p.to && p.from < e.to)) {
      out.push(e);
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * `{text, link}` の並び（`RichSpan` の列）から行内のリンク範囲を導く。隣り合う同じ
 * URL のスパンは 1 本に繋ぐ（`wrapRichLine` がスタイル単位で切っているため、
 * 1 つのリンクが複数スパンに割れていることがある）。
 */
export function spanLinks(
  spans: readonly { readonly text: string; readonly link?: string }[],
): LinkRange[] {
  const out: LinkRange[] = [];
  let at = 0;
  for (const span of spans) {
    const len = span.text.length;
    if (span.link !== undefined && len > 0) {
      const last = out[out.length - 1];
      if (last && last.to === at && last.url === span.link) {
        out[out.length - 1] = { from: last.from, to: at + len, url: span.link };
      } else {
        out.push({ from: at, to: at + len, url: span.link });
      }
    }
    at += len;
  }
  return out;
}

/** リンク境界で切り出した 1 片。`index` は元セグメントの位置（スタイルを引くため）。 */
export interface LinkPiece {
  readonly text: string;
  readonly index: number;
  /** この片が属するリンクの URL（リンク外なら undefined）。 */
  readonly url?: string;
}

/**
 * 横並びのセグメント列（1 行の `RichSpan` の text、またはプレーン行の 1 要素）を
 * **リンクの境界で**切り分ける。`selectionSlices`（選択境界で切る）と同じ発想で、
 * 段を分けてあるのは 2 つの境界が直交するため — こちらを先に通してから
 * `selectionSlices` に渡すと、選択とリンクの両方で正しく切れた片が得られる。
 */
export function linkPieces(segments: readonly string[], links?: readonly LinkRange[]): LinkPiece[] {
  if (!links || links.length === 0) {
    return segments.map((text, index) => ({ text, index }));
  }
  const out: LinkPiece[] = [];
  let at = 0;
  for (const [index, text] of segments.entries()) {
    let pos = 0;
    while (pos < text.length) {
      const abs = at + pos;
      const current = rangeAt(links, abs);
      // 次の境界: リンクの中ならその終わり、外なら次のリンクの始まり。
      let end = text.length;
      if (current) {
        end = Math.min(end, current.to - at);
      } else {
        for (const link of links) {
          if (link.from > abs) {
            end = Math.min(end, link.from - at);
          }
        }
      }
      out.push({ text: text.slice(pos, end), index, url: current?.url });
      pos = end;
    }
    at += text.length;
  }
  return out;
}

const OSC8_OPEN = '\u001b]8;;';
const OSC8_ST = '\u001b\\';

/**
 * OSC 8 ハイパーリンクで包む。対応端末（iTerm2 / VTE / Windows Terminal など）では
 * これで Cmd/Ctrl+click がネイティブに効く。**あくまで上乗せ**で、主経路は codiva 自身が
 * クリックを取って開く方（`logLinkAt` → `openUrl`）— 主端末の Ghostty は
 * マウスレポート中はリンク検出そのものを止めるため、OSC 8 だけでは開けない。
 *
 * 非対応端末は未知の OSC を黙って捨てるので、出しても表示は壊れない。
 *
 * **必ず描画時にだけ通す**。`LogEntry.text` や `RichSpan.text` にこのエスケープを
 * 混ぜてはいけない — `wrapDisplayLines` / `wrapRichLine` はエスケープを可視幅として
 * 数えるので、折り返し位置が壊れて URI が行の途中で断ち切られる。
 * パラメータ形（`id=`）は使わない（wrap-ansi 10 が壊す）。
 */
export function osc8(url: string, text: string): string {
  return `${OSC8_OPEN}${url}${OSC8_ST}${text}${OSC8_OPEN}${OSC8_ST}`;
}

/** OSC 8 として出してよい URL か（開ける形式で、長さが端末側の上限に収まる）。 */
export function canHyperlink(url: string | undefined): url is string {
  return url !== undefined && isOpenableUrl(url);
}
