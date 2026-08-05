/**
 * 起動シム。**このファイルに static import を書かないこと**（書いた瞬間に意味が消える）。
 *
 * ESM の static import は巻き上げられて本文より先に評価されるので、react /
 * react-reconciler より先に `NODE_ENV` を立てる方法は「動的 import の手前の文で代入する」
 * しかない（tsup の `banner` でも、シバンに `env -S` を書く手でも間に合わない。後者は
 * `node <path>` 直叩き＝mise 経由の起動でシバンを通らないので特に当てにならない）。
 *
 * なぜ production を既定にするか: `react-reconciler` は **dev ビルドのモジュール評価時**に
 * `supportsUserTiming`（`console.timeStamp` と `performance.measure` があるか）を確定し、
 * 以後レンダーごとに `performance.measure()` を 3 本積む（React 19.2 の Performance Tracks）。
 * Node の performance タイムラインは user timing エントリを**自動では捨てない**ため、
 * 長時間動く TUI ではヒープが単調に増えて最後に OOM する（実測: 空 Box の再描画だけで
 * 2,230 B/フレーム。10 描画/秒 ≒ 86MB/時 で既定のヒープ上限 ~4GB に到達する。実際に
 * ユーザー環境で 3 回落ちた）。production ビルドなら確保そのものが無くなり、描画も
 * 2.5 倍速い（8,000 回で 414ms → 166ms）。
 *
 * 既に値が入っているときは尊重する（`NODE_ENV=development npm run dev` で React の
 * dev 警告を戻せる）。保険として `bootstrap/perf-timeline.ts` がタイムラインを定期的に
 * 掃除する（dev ビルドで動かしたときや、将来 React 側の実装が変わったときのため）。
 */
process.env.NODE_ENV ??= 'production';

// static import が無いとこのファイルは TS 的に「スクリプト」扱いになり、top-level await が
// 使えない。ESM であることを示すためだけの空 export（値の再エクスポートではないので
// 「末尾の export ブロックを書かない」規約には当たらない）。
export {};

// 失敗したらこのモジュールの評価が reject する = 終了コードが 0 にならない。
await import('./main');
