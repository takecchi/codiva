/**
 * 子プロセスへ渡す環境変数の組み立て（純粋）。実体化は `utils/child-env.ts`。
 *
 * codiva は起動シム（`src/index.tsx`）で `NODE_ENV` を `production` に固定する。あれは
 * react-reconciler を dev ビルドで評価させないための load-bearing な代入だが、
 * **`process.env` への代入は spawn した子プロセスすべてに継承される**。エージェントの
 * シェルもその下に居るので、セッション内で叩く `npm install` / `npm ci` が
 * `NODE_ENV=production` = `--omit=dev` と解釈され、devDependencies が黙って入らない
 * （型定義もテストランナーも欠けた状態になり、原因が npm だと気付けない。issue #103）。
 *
 * 直し方は「codiva 自身の `NODE_ENV` は production のまま、子には元の値を渡す」。
 * 起動シムは自分で立てたときだけ {@link NODE_ENV_INJECTED_VAR} を `'1'` にしておき、
 * ここがそれを見て `NODE_ENV` を落とす（ユーザーが明示的に `NODE_ENV=development` で
 * 起動したなら `??=` が尊重するのと同じく、子にもその値がそのまま渡る）。
 */

/** 環境変数の表（`process.env` と同じ形）。 */
export type EnvRecord = Record<string, string | undefined>;

/**
 * 「`NODE_ENV` は codiva が立てたものだ」という目印。起動シムが立て、
 * {@link childEnv} が落とす（codiva の内部事情なので子プロセスには見せない）。
 */
export const NODE_ENV_INJECTED_VAR = 'CODIVA_NODE_ENV_INJECTED';

/**
 * 子プロセスへ渡す env を作る。codiva が立てた `NODE_ENV` と内部マーカーを取り除いた
 * コピーを返す（引数は変更しない）。
 */
export function childEnv(env: EnvRecord): EnvRecord {
  const next: EnvRecord = { ...env };
  // 空文字は「元から入っていた」= 落とさない（`'1'` のときだけ codiva 由来）。
  if (next[NODE_ENV_INJECTED_VAR]) {
    delete next.NODE_ENV;
  }
  delete next[NODE_ENV_INJECTED_VAR];
  return next;
}
