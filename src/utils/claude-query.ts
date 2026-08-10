import { query } from '@anthropic-ai/claude-agent-sdk';
import { childProcessEnv } from './child-env';

/**
 * SDK の `query` に「子プロセスへ渡す env」を被せたもの。
 *
 * **codiva から Claude を起こす経路はここ 1 本にする**（セッション本体・タイトル生成・
 * probe の全部）。素の `query` を使うと、起動シムが立てた `NODE_ENV=production` が
 * `claude` サブプロセス → エージェントのシェルまで継承され、セッション内の
 * `npm install` / `npm ci` が devDependencies を落とす（issue #103）。
 *
 * `Options.env` は `process.env` とマージされず**丸ごと置き換える**ので、
 * `childProcessEnv()` が `process.env` のコピーを返すことに依存している
 * （部分的な差分を渡すと認証情報ごと消える）。
 */
export const claudeQuery: typeof query = (params) =>
  query({ ...params, options: { ...params.options, env: childProcessEnv() } });
