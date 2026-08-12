/**
 * JSONL（1 行 1 JSON）の枠切り（純粋）。**provider 非依存** — `codex exec --json` の
 * stdout も `grok agent stdio` の JSON-RPC も「行区切りの JSON」なので両方が使う。
 * チャンクは行の途中で切れるし、ツール出力を丸ごと 1 行で運ぶ実装もあるので巨大にもなる。
 *
 * プロセスの扱い（`utils/codex.ts` / `utils/grok.ts`）と分けてここに置くのは、
 * **この framing こそテストしたい部分**だから（部分行・CRLF・末尾行・上限超過）。
 *
 * `maxLineChars` を超えた行は**捨てて次の改行まで読み飛ばす**。溜め切ってから
 * `JSON.parse` すると同じものが 2 部ヒープに載る（このリポジトリは同種の積み上げで
 * 実際に OOM している）ので、1 イベントを失うほうを選ぶ。
 */
export function createJsonlSplitter(maxLineChars: number): {
  /** チャンクを流し込み、確定した JSON 値を返す（壊れた行・空行は落ちる）。 */
  push(chunk: string): unknown[];
  /** ストリーム終端。改行で終わっていない最後の行を確定させる。 */
  flush(): unknown[];
} {
  let buffer = '';
  // 「今の行が長すぎるので次の改行まで捨てる」状態。
  let skipping = false;

  const take = (line: string, out: unknown[]): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // JSONL 以外の行（想定外）は捨てる。TUI を落とさない。
    }
  };

  return {
    push(chunk: string): unknown[] {
      const out: unknown[] = [];
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (skipping) {
          skipping = false;
        } else {
          take(line, out);
        }
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > maxLineChars) {
        buffer = '';
        skipping = true;
      }
      return out;
    },
    flush(): unknown[] {
      const out: unknown[] = [];
      if (!skipping) {
        take(buffer, out);
      }
      buffer = '';
      skipping = false;
      return out;
    },
  };
}
