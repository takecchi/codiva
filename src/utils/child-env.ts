import { childEnv, type EnvRecord } from '@/core';

/**
 * 子プロセスへ渡す `env`（実 `process.env` への適用）。判定は純粋な
 * `core/child-env.ts` にある。
 *
 * **codiva からプロセスを起こすときは必ずこれを渡す**。渡さないと起動シムが立てた
 * `NODE_ENV=production` が継承され、セッション内の `npm install` が devDependencies を
 * 落とす（issue #103）。番人は `child-env.spec.ts` の「`node:child_process` を使う
 * utils は childProcessEnv を通す」。
 *
 * 毎回作り直すのは、`process.env` が起動後に変わり得る（`main.tsx` の配線・テスト）ため。
 * spawn の頻度はセッション単位なので、コピーのコストは問題にならない。
 */
export function childProcessEnv(): EnvRecord {
  return childEnv(process.env);
}
