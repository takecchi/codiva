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
   * 復元時に丸める先の状態。undefined は「永続対象外」を意味する
   * (creating = worktree 未作成、conflict/archived = 復元しない)。
   */
  restoreAs?: 'completed' | 'interrupted' | 'failed';
  /** デスクトップ通知の文言キー(`Messages['notify']`)。undefined は通知しない。 */
  notifyKey?: keyof Messages['notify'];
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  creating: { terminal: false, attention: false },
  running: { terminal: false, attention: false, restoreAs: 'interrupted' },
  awaiting_permission: {
    terminal: false,
    attention: true,
    restoreAs: 'interrupted',
    notifyKey: 'needsPermission',
  },
  awaiting_input: {
    terminal: false,
    attention: true,
    restoreAs: 'interrupted',
    notifyKey: 'needsInput',
  },
  completed: { terminal: true, attention: false, restoreAs: 'completed', notifyKey: 'completed' },
  interrupted: { terminal: true, attention: false, restoreAs: 'interrupted' },
  // A rate limit is transient — by the time the app restarts the limit may have
  // reset, so restore it as a plain resumable (idle = interrupted) session.
  rate_limited: {
    terminal: true,
    attention: false,
    restoreAs: 'interrupted',
    notifyKey: 'rateLimited',
  },
  failed: { terminal: true, attention: false, restoreAs: 'failed', notifyKey: 'failed' },
  conflict: { terminal: true, attention: false },
  archived: { terminal: true, attention: false },
};

/** 終端状態（これ以上 SDK ストリームが状態を進めない）か。 */
export function isTerminalStatus(status: SessionStatus): boolean {
  return STATUS_META[status].terminal;
}

/** 一覧上でユーザーの操作を促す（許可待ち・質問待ち）状態か。 */
export function needsAttention(status: SessionStatus): boolean {
  return STATUS_META[status].attention;
}
