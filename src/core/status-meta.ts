import type { Messages } from './i18n';
import type { SessionStatus } from './types';

/**
 * 各 `SessionStatus` の「性質」を一元管理するテーブル。terminal 判定・一覧の注意喚起・
 * 復元時の丸め先・通知文言キーがここに集約されているので、状態を1つ増やしても触るのは
 * この表・reducer・色(theme)・ラベル(i18n) に限定される（以前は9ファイルへ散在していた）。
 *
 * 色(`ui/theme.ts` の `statusColor`)とラベル文言(`i18n.ts` / `badgeFor`)は「表示」の関心なので
 * ここには持たない — この表は状態の意味論だけを扱う。
 */
export interface StatusMeta {
  /** 終端状態か。詳細ビューの差分表示可否・一覧の並び等の判定に使う。 */
  terminal: boolean;
  /** ユーザーの操作待ちで一覧上に注意グリフ(●)を出すか。 */
  attention: boolean;
  /**
   * 「稼働中」か。セッション動作時間の換算対象（creating/running のみ）。
   * ユーザー操作待ち(awaiting_*)や終端状態は idle なので false — この時間は
   * 動作時間に含めない（wall-clock ではなく「実際に動いた時間」を計るため）。
   */
  active: boolean;
  /**
   * ユーザーが中断（詳細ビューの `Ctrl+C`）できる「ターンが進行中」の状態か。
   * SDK の query が走っていて interrupt 制御要求が意味を持つ区間 = `running` と
   * 許可/質問待ち（`awaiting_*`。ターンは生きていて回答待ちで止まっているだけ）。
   * `creating` は worktree の用意中でまだ query が無いので false、終端状態も false。
   * `active`（動作時間の積算）とは意図的に別のフラグ: awaiting_* は「動いていない」が
   * 「中断できる」ので、両者は一致しない。
   */
  interruptible: boolean;
  /**
   * 「中断されて再開待ち」か。一覧/詳細に明示的な再開（continue）アクションを出す。
   * クリーンに完了したわけではないが resume で続行できる状態が該当する
   * (`interrupted` / `rate_limited` / `needs_login`)。`completed` は追加指示を
   * 受けられるが「中断」ではないため false。
   */
  resumable: boolean;
  /**
   * 復元時に丸める先の状態。undefined は「永続対象外」を意味する
   * (creating = worktree 未作成、conflict/archived = 復元しない)。
   */
  restoreAs?: 'completed' | 'interrupted' | 'failed';
  /** デスクトップ通知の文言キー(`Messages['notify']`)。undefined は通知しない。 */
  notifyKey?: keyof Messages['notify'];
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  creating: {
    terminal: false,
    attention: false,
    active: true,
    interruptible: false,
    resumable: false,
  },
  running: {
    terminal: false,
    attention: false,
    active: true,
    interruptible: true,
    resumable: false,
    restoreAs: 'interrupted',
  },
  awaiting_permission: {
    terminal: false,
    attention: true,
    active: false,
    interruptible: true,
    resumable: false,
    restoreAs: 'interrupted',
    notifyKey: 'needsPermission',
  },
  awaiting_input: {
    terminal: false,
    attention: true,
    active: false,
    interruptible: true,
    resumable: false,
    restoreAs: 'interrupted',
    notifyKey: 'needsInput',
  },
  completed: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: false,
    restoreAs: 'completed',
    notifyKey: 'completed',
  },
  interrupted: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: true,
    restoreAs: 'interrupted',
    notifyKey: 'interrupted',
  },
  // A rate limit is transient — by the time the app restarts the limit may have
  // reset, so restore it as a plain resumable (idle = interrupted) session.
  rate_limited: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: true,
    restoreAs: 'interrupted',
    notifyKey: 'rateLimited',
  },
  // Claude's credentials expired. `attention: true` — unlike a rate limit this
  // never clears on its own: the user must log in again (`claude` → /login)
  // before the session can go anywhere, so the list flags it like a prompt.
  // Restored as `interrupted` because by the next launch the user may well have
  // logged back in (the state says nothing about the work itself).
  needs_login: {
    terminal: true,
    attention: true,
    active: false,
    interruptible: false,
    resumable: true,
    restoreAs: 'interrupted',
    notifyKey: 'needsLogin',
  },
  failed: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: false,
    restoreAs: 'failed',
    notifyKey: 'failed',
  },
  conflict: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: false,
  },
  archived: {
    terminal: true,
    attention: false,
    active: false,
    interruptible: false,
    resumable: false,
  },
};

/** 終端状態（これ以上 SDK ストリームが状態を進めない）か。 */
export function isTerminalStatus(status: SessionStatus): boolean {
  return STATUS_META[status].terminal;
}

/** 一覧上でユーザーの操作を促す（許可待ち・質問待ち）状態か。 */
export function needsAttention(status: SessionStatus): boolean {
  return STATUS_META[status].attention;
}

/**
 * 「稼働中」（動作時間の換算対象）か。creating/running のみ true。
 * idle（awaiting_*）・終端状態はユーザー操作待ちや停止中なので含めない。
 */
export function isActiveStatus(status: SessionStatus): boolean {
  return STATUS_META[status].active;
}

/**
 * ユーザーが中断（詳細ビューの `Ctrl+C`）できる状態か。`running` と許可/質問待ち
 * （`awaiting_*` = ターンは生きていて回答待ちで止まっているだけ）が対象。
 * `creating`（query 未起動）と終端状態には止めるターンが無いので false。
 */
export function isInterruptible(status: SessionStatus): boolean {
  return STATUS_META[status].interruptible;
}

/**
 * 「中断されて再開待ち」か。通信断で止まった `interrupted`、使用量制限で止まった
 * `rate_limited`、認証切れで止まった `needs_login` が該当する。いずれも
 * 「クリーンに完了したわけではないが resume で続行できる」状態なので、一覧/詳細に
 * 明示的な再開（continue）アクションを出す。`completed` は追加指示を受けられるが
 * 「中断」ではないため対象外。
 */
export function isResumable(status: SessionStatus): boolean {
  return STATUS_META[status].resumable;
}
