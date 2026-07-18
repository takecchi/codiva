/**
 * UI 文字列の多言語カタログと言語解決ロジック。ここは純粋（Ink/React/I-O 非依存）。
 *
 * 文字列はすべてこの `messages` カタログに集約する。UI コンポーネントに直接
 * 文字列リテラルを書かない（規約: .claude/rules/i18n.md）。動的な差し込み・
 * 複数形などは、型安全に保つため文字列テンプレート関数として持つ。
 */

export type Lang = 'ja' | 'en';

/** サポート言語の一覧（順序は UI での並びに使える）。 */
export const LANGS: readonly Lang[] = ['ja', 'en'];

/**
 * 全 UI 文字列の型。ja/en 両カタログはこの型を満たすため、キー欠落は型エラーで検知できる
 * （加えて i18n.spec.ts が両カタログのキー集合の一致も検証する）。
 */
export interface Messages {
  /** 一覧ビュー（session-list.tsx） */
  list: {
    sessionCount: (n: number) => string;
    emptyHint: string;
    promptPlaceholder: string;
    help: string;
  };
  /** 詳細ビュー（session-detail.tsx） */
  detail: {
    notFound: string;
    progress: (done: number, total: number, active: string | undefined) => string;
    errorLabel: string;
    changesTitle: (branch: string) => string;
    noCommittedChanges: string;
    uncommitted: (n: number) => string;
    actionErrorLabel: string;
    followupPlaceholder: string;
    actionsTitle: string;
    mergePrompt: string;
    discardPrompt: string;
    confirmRun: string;
    busySuffix: string;
    mergeAction: string;
    discardAction: string;
    helpPending: string;
    helpActions: string;
    helpInput: string;
  };
  /** ステータスバッジ（progress-badge.tsx） */
  badge: {
    creating: string;
    running: string;
    step: (done: number, total: number) => string;
    awaitingPermission: string;
    awaitingInput: string;
    completed: string;
    failed: string;
    archived: string;
  };
  /** 許可・質問ダイアログ（permission-dialog.tsx） */
  permission: {
    denied: string;
    toolTitle: (tool: string) => string;
    allow: string;
    deny: string;
    questionTitle: (index: number, total: number, header: string) => string;
    questionHelp: (multiSelect: boolean) => string;
  };
  /** アプリ全体（index.tsx） */
  app: {
    remainingWorktrees: (n: number) => string;
  };
}

const ja: Messages = {
  list: {
    sessionCount: (n) => `${n} セッション`,
    emptyHint: '指示を入力して Enter を押すと最初のセッションが始まります。',
    promptPlaceholder: '実装してほしいことを入力…',
    help: 'Enter: 投入 ・ ↑↓: 選択 ・ →: 詳細 ・ Ctrl+C: 終了',
  },
  detail: {
    notFound: 'セッションが見つかりません。Esc で戻ります。',
    progress: (done, total, active) => `進捗 ${done}/${total}${active ? ` — ${active}` : ''}`,
    errorLabel: 'エラー',
    changesTitle: (branch) => `変更（${branch} vs ベース）:`,
    noCommittedChanges: '（コミット済みの変更なし）',
    uncommitted: (n) => `未コミット ${n} 件`,
    actionErrorLabel: '操作エラー',
    followupPlaceholder: '追加の指示を入力…',
    actionsTitle: '操作',
    mergePrompt: 'ベースへマージします。',
    discardPrompt: 'worktree とブランチを破棄します。',
    confirmRun: '実行しますか？',
    busySuffix: '…実行中',
    mergeAction: 'マージ（--no-ff）',
    discardAction: '破棄（worktree削除）',
    helpPending: 'Esc: 一覧へ戻る',
    helpActions: 'm/d: 操作 ・ Tab: 入力へ ・ Esc: 戻る',
    helpInput: 'Enter: 送信 ・ Tab: 操作 ・ Esc/←: 一覧へ戻る',
  },
  badge: {
    creating: '準備中',
    running: '実行中',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: '許可待ち',
    awaitingInput: '質問あり',
    completed: '完了',
    failed: '失敗',
    archived: '保管済み',
  },
  permission: {
    denied: 'ユーザーが拒否しました',
    toolTitle: (tool) => `ツール実行の許可: ${tool}`,
    allow: '許可',
    deny: '拒否',
    questionTitle: (index, total, header) => `質問 (${index}/${total}) ${header}`,
    questionHelp: (multiSelect) =>
      `↑↓: 選択 ・ ${multiSelect ? 'Space: トグル ・ ' : ''}Enter: 決定`,
  },
  app: {
    remainingWorktrees: (n) =>
      `codiva: ${n} 個の worktree が残っています（作業内容は保持されます）:`,
  },
};

const en: Messages = {
  list: {
    sessionCount: (n) => `${n} session${n === 1 ? '' : 's'}`,
    emptyHint: 'Type an instruction and press Enter to start your first session.',
    promptPlaceholder: 'Describe what you want built…',
    help: 'Enter: submit · ↑↓: select · →: detail · Ctrl+C: quit',
  },
  detail: {
    notFound: 'Session not found. Press Esc to go back.',
    progress: (done, total, active) => `Progress ${done}/${total}${active ? ` — ${active}` : ''}`,
    errorLabel: 'error',
    changesTitle: (branch) => `Changes (${branch} vs base):`,
    noCommittedChanges: '(no committed changes)',
    uncommitted: (n) => `${n} uncommitted change${n === 1 ? '' : 's'}`,
    actionErrorLabel: 'Action error',
    followupPlaceholder: 'Enter a follow-up instruction…',
    actionsTitle: 'Actions',
    mergePrompt: 'Merge into the base branch.',
    discardPrompt: 'Discard the worktree and branch.',
    confirmRun: 'Proceed?',
    busySuffix: '…running',
    mergeAction: 'Merge (--no-ff)',
    discardAction: 'Discard (remove worktree)',
    helpPending: 'Esc: back to list',
    helpActions: 'm/d: actions · Tab: input · Esc: back',
    helpInput: 'Enter: send · Tab: actions · Esc/←: back to list',
  },
  badge: {
    creating: 'Preparing',
    running: 'Running',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: 'Awaiting permission',
    awaitingInput: 'Question',
    completed: 'Completed',
    failed: 'Failed',
    archived: 'Archived',
  },
  permission: {
    denied: 'Denied by the user',
    toolTitle: (tool) => `Allow tool: ${tool}`,
    allow: 'allow',
    deny: 'deny',
    questionTitle: (index, total, header) => `Question (${index}/${total}) ${header}`,
    questionHelp: (multiSelect) =>
      `↑↓: select · ${multiSelect ? 'Space: toggle · ' : ''}Enter: confirm`,
  },
  app: {
    remainingWorktrees: (n) =>
      `codiva: ${n} worktree${n === 1 ? '' : 's'} left in place (your work is preserved):`,
  },
};

/** 言語 → カタログ。UI は `messages[lang]` を購読する。 */
export const messages: Record<Lang, Messages> = { ja, en };

/** POSIX ロケール文字列（例: "ja_JP.UTF-8"）から言語を推定する。ja* のみ日本語、他は英語。 */
export function detectLocaleLang(locale: string | undefined): Lang {
  return locale?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** 明示指定（環境変数・設定ファイル）を Lang へ正規化する。ja / en 系（ja*, en*）のみ受理。 */
export function normalizeLang(value: string | undefined): Lang | undefined {
  if (!value) {
    return undefined;
  }
  const s = value.toLowerCase();
  if (s.startsWith('ja')) {
    return 'ja';
  }
  if (s.startsWith('en')) {
    return 'en';
  }
  return undefined;
}

/**
 * 表示言語を決定する。優先順位:
 *   1. 環境変数 CODIVA_LANG（明示上書き）
 *   2. 設定ファイルの language（'auto' 以外）
 *   3. OS ロケール（'auto' または未設定のとき）→ ja* なら日本語、他は英語
 */
export function resolveLang(input: {
  env?: string;
  config?: Lang | 'auto';
  locale?: string;
}): Lang {
  const fromEnv = normalizeLang(input.env);
  if (fromEnv) {
    return fromEnv;
  }
  if (input.config === 'ja' || input.config === 'en') {
    return input.config;
  }
  return detectLocaleLang(input.locale);
}
