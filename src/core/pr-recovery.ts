import type { Messages } from './i18n';
import { isTerminalStatus } from './status-meta';
import type { PrCheckRun, SessionState } from './types';
import type { SyncBaseResult } from './worktree';

/**
 * 「PR が詰まっているセッションを立て直す」判定と、そのときセッションへ送る指示文
 * （純粋・I/O 非依存）。実際の git / `gh` 実行は `utils/worktree-manager.ts` と
 * `SessionManager.recover()` が持ち、ここは**何をすべきか**だけを決める。
 *
 * 詰まり方は 2 つしかない:
 *  - `sync` … GitHub が `mergeable: CONFLICTING` と言っている（ベースが先に進んだ）
 *  - `ci`   … チェックが赤い
 * 前者はまず codiva 自身がベースを取り込んでみる（トークンを使わない）。競合したら
 * その worktree に競合を残したままエージェントへ渡す（`-X ours` 等での自動解消は
 * 規約で禁止 — コードを無言で捨てるため。人間の代わりに判断できるのはエージェント）。
 * 後者は codiva が失敗したチェック名を添えて指示するだけで、ログの取得（`gh run view
 * --log-failed`）と修正はエージェントにやらせる。
 */

/** どの立て直しが要るか。`sync` = ベース取り込み、`ci` = CI 修正。 */
export type RecoveryKind = 'sync' | 'ci';

/**
 * 失敗チェックを指示文に載せる上限。matrix ジョブが全落ちすると数十件になり得るので、
 * プロンプトを埋め尽くさないよう頭から数件だけ渡す（残りはエージェントが `gh` で辿れる）。
 */
export const MAX_FAILING_CHECKS = 8;

/**
 * 自動立て直し（設定 `autoSync` / `autoFixCi`）を 1 セッション・1 種類あたり何回まで
 * 試すか。上限が要るのは「指示したのにエージェントが push しなかった」ケースで、
 * チェックは赤いままなのでポーリングのたびに永久に投げ直してしまうため。
 * 手動の `/sync` / `/fix-ci` はこの上限の対象外（人が押した回数だけ走る）。
 */
export const MAX_AUTO_RECOVERY_ATTEMPTS = 2;

/**
 * **PR だけ**を見た詰まり方を、優先度順に**すべて**返す（セッションが何をしているかは見ない）。
 *
 * 複数返すのは、競合と CI 失敗が同時に起きるから。`autoFixCi` だけを有効にしている人の
 * 「競合していて、かつ赤い」PR で、先頭（`sync`）が無効だからと諦めてしまうと、
 * 有効にしたはずの自動化が永久に何もしない。
 *
 * 順序（sync → ci）は「ベースを取り込めばチェックはどのみち回り直すので、先に CI を
 * 直しても無駄になる」から。両方できるなら sync を先に。
 */
export function stuckKinds(state: SessionState): RecoveryKind[] {
  const status = state.prStatus;
  if (!state.pr || !status || status.mergeStatus === 'merged') {
    return [];
  }
  const kinds: RecoveryKind[] = [];
  if (status.mergeStatus === 'conflicting') {
    kinds.push('sync');
  }
  if (status.checks === 'failing') {
    kinds.push('ci');
  }
  return kinds;
}

/**
 * `recoveryKindFor` からセッション状態のゲートを外したもの（優先度が最も高い 1 件）。
 * 「今は走っているから対象外」と「もう詰まっていない」を混同しないために要る。
 */
export function prStuckKind(state: SessionState): RecoveryKind | undefined {
  return stuckKinds(state)[0];
}

/**
 * PR が**確かに健全になった**か。自動立て直しの試行回数を返してよいのはこのときだけ。
 *
 * 「詰まっていない」（`prStuckKind` が undefined）では判定に使えない。push した直後の PR は
 * 必ず `checks: 'pending'` や `mergeStatus: 'unknown'` を経由し、そこは「詰まっていない」に
 * 該当してしまうため:
 *
 *   赤い → 依頼(1) → エージェントが直らない修正を push → pending（**ここでリセット**）
 *   → また赤い → 依頼(1) → … と、上限があっても永久にターンが回る。
 *
 * 実際に多いのは「依頼したが直せなかった」ほうなので、これを塞がないと上限の意味が無い。
 * なので緑（またはマージ済み）を見たときだけ返金する。
 */
export function prRecovered(state: SessionState): boolean {
  const status = state.prStatus;
  if (!status) {
    return false;
  }
  if (status.mergeStatus === 'merged') {
    return true;
  }
  // `none` は「チェックが設定されていない」= これ以上緑になりようがないので健全側。
  return (
    status.mergeStatus === 'mergeable' && (status.checks === 'passing' || status.checks === 'none')
  );
}

/**
 * このセッションを今どう立て直すべきか（不要なら undefined）= 詰まっている
 * （{@link prStuckKind}）かつ**手が空いている**こと。
 *
 * 終端状態に限るのが要点。走っている最中に指示を割り込ませても、そのターンの作業と
 * 競合するだけで得がない。`archived` は畳んだ行なので対象外。
 */
export function recoveryKindFor(state: SessionState): RecoveryKind | undefined {
  if (state.status === 'archived' || !isTerminalStatus(state.status)) {
    return undefined;
  }
  return prStuckKind(state);
}

/** 立て直しの対象になるセッションと、その種類（一括実行用。一覧順を保つ）。 */
export function recoverableSessions(
  sessions: readonly SessionState[],
): { state: SessionState; kind: RecoveryKind }[] {
  const out: { state: SessionState; kind: RecoveryKind }[] = [];
  for (const state of sessions) {
    const kind = recoveryKindFor(state);
    if (kind) {
      out.push({ state, kind });
    }
  }
  return out;
}

/**
 * 立て直しの結末。UI はこれをそのまま文言（`m.recover.*`）へ写す。
 *  - `synced`     … ベースを取り込んで push した（エージェント不関与 = 無課金）
 *  - `upToDate`   … 取り込むものが無かった（同上）
 *  - `delegated`  … セッションへ指示を送った（ここからはターンが回る）
 *  - `skipped`    … 立て直す理由が無い / 対象外
 *  - `error`      … git / gh が失敗した
 */
export type RecoveryOutcome =
  | { kind: 'synced' }
  | { kind: 'upToDate' }
  | { kind: 'delegated'; recovery: RecoveryKind }
  | { kind: 'skipped' }
  | { kind: 'busy' }
  | { kind: 'error'; error: string };

/**
 * 立て直しの結末 → ユーザーへ出す 1 行（エラーは呼び出し側がエラー欄へ出すので undefined）。
 * 純粋なので一覧・詳細で共有でき、二重に文言を組み立てずに済む。
 */
export function recoveryNotice(outcome: RecoveryOutcome, m: Messages): string | undefined {
  switch (outcome.kind) {
    case 'synced':
      return m.recover.synced;
    case 'upToDate':
      return m.recover.upToDate;
    case 'delegated':
      return outcome.recovery === 'sync' ? m.recover.delegatedSync : m.recover.delegatedCi;
    case 'skipped':
      return m.recover.skipped;
    case 'busy':
      return m.recover.busySession;
    default:
      return undefined;
  }
}

/** `git merge` の結果 → エージェントへ渡す指示文（渡す必要が無ければ undefined）。 */
export function syncInstruction(
  result: SyncBaseResult,
  base: string,
  m: Messages,
): string | undefined {
  if (result.kind === 'conflict') {
    return m.recover.conflictInstruction(base, result.files);
  }
  if (result.kind === 'dirty') {
    // 未コミットの変更がある worktree へ merge を被せると、エージェントの書きかけと
    // 取り込みが混ざって解けなくなる。作業の持ち主（エージェント）自身に、まとめて
    // からベースを取り込ませる。
    return m.recover.dirtyInstruction(base, result.files);
  }
  return undefined;
}

/** 赤いチェックの一覧 → CI 修正の指示文。名前が取れていなくても手順だけは渡す。 */
export function ciFixInstruction(
  branch: string,
  checks: readonly PrCheckRun[] | undefined,
  m: Messages,
): string {
  const named = (checks ?? []).slice(0, MAX_FAILING_CHECKS);
  return m.recover.ciInstruction(
    branch,
    named.map((c) => (c.url ? `${c.name} (${c.url})` : c.name)),
  );
}
