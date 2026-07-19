/**
 * UI 文字列の多言語カタログと言語解決ロジック。ここは純粋（Ink/React/I-O 非依存）。
 *
 * 文字列はすべてこの `messages` カタログに集約する。UI コンポーネントに直接
 * 文字列リテラルを書かない（規約: .claude/rules/i18n.md）。動的な差し込み・
 * 複数形などは、型安全に保つため文字列テンプレート関数として持つ。
 */

import type { ModelId } from './models';

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
    totalCost: (usd: string) => string;
    emptyHint: string;
    promptPlaceholder: string;
    /** 入力（コンポーザ）フォーカス時のフッタヒント */
    helpComposer: string;
    /** セッション一覧フォーカス時のフッタヒント */
    helpList: string;
    /** 選択中セッションの許可/質問ダイアログがキーを持つ間のヒント */
    helpPending: string;
    actionErrorLabel: string;
    mergePrompt: string;
    discardPrompt: string;
    confirmRun: string;
    busySuffix: string;
    /** 一覧スクロール時、上に隠れている件数のインジケータ */
    moreAbove: (n: number) => string;
    /** 一覧スクロール時、下に隠れている件数のインジケータ */
    moreBelow: (n: number) => string;
  };
  /** 詳細ビュー（session-detail.tsx） */
  detail: {
    notFound: string;
    progress: (done: number, total: number, active: string | undefined) => string;
    cost: (usd: string) => string;
    errorLabel: string;
    changesTitle: (branch: string) => string;
    noCommittedChanges: string;
    uncommitted: (n: number) => string;
    actionErrorLabel: string;
    followupPlaceholder: string;
    scrollHint: (newerBelow: number) => string;
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
    conflict: string;
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
  /** モデル選択ダイアログ（model-select.tsx。/model コマンドで開く） */
  model: {
    /** ダイアログ見出し */
    title: string;
    /** ダイアログ下部の操作ヒント */
    help: string;
    /** 既定モデルに付ける「推奨」ラベル */
    recommended: string;
    /** 選択確定後のフッタ通知（name は選んだモデルの表示名） */
    saved: (name: string) => string;
    /** 選択肢の表示名（ブランド名。default のみ翻訳語） */
    names: Record<ModelId, string>;
    /** 選択肢の説明文 */
    descriptions: Record<ModelId, string>;
  };
  /** アプリ全体（index.tsx） */
  app: {
    remainingWorktrees: (n: number) => string;
  };
  /** デスクトップ通知（notify.ts） */
  notify: {
    needsInput: string;
    needsPermission: string;
    completed: string;
    failed: string;
  };
  /** 起動バナー（banner.tsx） */
  banner: {
    subtitle: string;
    /** 使用中モデルの表示（設定 model。未設定は CLI 既定）。 */
    model: (name: string) => string;
    /** model 未設定時に表示するプレースホルダ（CLI 既定）。 */
    defaultModel: string;
  };
  /** 下部モード行（status-footer.tsx） */
  footer: {
    autoMode: string;
    confirmMode: string;
    cycleHint: string;
  };
  /** スラッシュコマンド（commands.ts / command-palette.tsx） */
  command: {
    /** 入力中に出るコマンドパレットの見出し */
    paletteTitle: string;
    /** 前方一致するコマンドが無いときの表示 */
    paletteEmpty: string;
    /** /help のヘルプ一覧の見出し */
    helpTitle: string;
    /** 未知のコマンドを打ったときのエラー */
    unknown: (name: string) => string;
    /** /help の説明 */
    help: string;
    /** /quit の説明 */
    quit: string;
    /** /model の説明 */
    model: string;
  };
}

const ja: Messages = {
  list: {
    sessionCount: (n) => `${n} セッション`,
    totalCost: (usd) => `合計 ${usd}`,
    emptyHint: '指示を入力して Enter を押すと最初のセッションが始まります。',
    promptPlaceholder: '実装してほしいことを入力…',
    helpComposer: 'Enter: 投入 ・ Shift+Enter: 改行 ・ Tab: 一覧へ ・ Ctrl+C: 終了',
    helpList:
      '↑↓: 選択 ・ Enter/→: 詳細を開く ・ p: PRを開く ・ m: マージ ・ d: 破棄 ・ Tab/Esc: 入力へ',
    helpPending: 'ダイアログで回答 ・ PgUp/PgDn: 選択移動 ・ Tab: 入力へ',
    actionErrorLabel: '操作エラー',
    mergePrompt: 'ベースへマージします。',
    discardPrompt: 'worktree とブランチを破棄します。',
    confirmRun: '実行しますか？',
    busySuffix: '…実行中',
    moreAbove: (n) => `↑ 他 ${n} 件`,
    moreBelow: (n) => `↓ 他 ${n} 件`,
  },
  detail: {
    notFound: 'セッションが見つかりません。Esc で戻ります。',
    progress: (done, total, active) => `進捗 ${done}/${total}${active ? ` — ${active}` : ''}`,
    cost: (usd) => `コスト ${usd}`,
    errorLabel: 'エラー',
    changesTitle: (branch) => `変更（${branch} vs ベース）:`,
    noCommittedChanges: '（コミット済みの変更なし）',
    uncommitted: (n) => `未コミット ${n} 件`,
    actionErrorLabel: '操作エラー',
    followupPlaceholder: '追加の指示を入力…',
    scrollHint: (n) => `▲ 過去ログを表示中 — 最新まで ${n} 件（PgDn で下へ）`,
    actionsTitle: '操作',
    mergePrompt: 'ベースへマージします。',
    discardPrompt: 'worktree とブランチを破棄します。',
    confirmRun: '実行しますか？',
    busySuffix: '…実行中',
    mergeAction: 'マージ（--no-ff）',
    discardAction: '破棄（worktree削除）',
    helpPending: 'Esc: 一覧へ戻る',
    helpActions: 'm/d: 操作 ・ Tab: 入力へ ・ Esc: 戻る',
    helpInput: 'Enter: 送信 ・ Shift+Enter: 改行 ・ PgUp/PgDn: ログ ・ Tab: 操作 ・ Esc: 一覧へ',
  },
  badge: {
    creating: '準備中',
    running: '実行中',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: '許可待ち',
    awaitingInput: '質問あり',
    completed: '完了',
    failed: '失敗',
    conflict: 'コンフリクト',
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
  model: {
    title: 'モデルを選択',
    help: '↑↓: 選択 ・ Enter: 決定 ・ Esc: キャンセル',
    recommended: '推奨',
    saved: (name) => `モデルを ${name} に変更しました（以降の新規セッションに適用）`,
    names: {
      default: 'デフォルト',
      opus: 'Opus',
      fable: 'Fable',
      sonnet: 'Sonnet',
      haiku: 'Haiku',
    },
    descriptions: {
      default: 'CLI 既定のモデルを使用',
      opus: 'Opus 4.8 ・ 日常的で複雑なタスクに最適',
      fable: 'Fable 5 ・ 最難関・長時間タスク向けの最上位',
      sonnet: 'Sonnet 5 ・ 日常タスクを効率的に',
      haiku: 'Haiku 4.5 ・ 手早い回答に最速',
    },
  },
  app: {
    remainingWorktrees: (n) =>
      `codiva: ${n} 個の worktree が残っています（作業内容は保持されます）:`,
  },
  notify: {
    needsInput: '質問があります',
    needsPermission: '許可を待っています',
    completed: '完了しました',
    failed: '失敗しました',
  },
  banner: {
    subtitle: '並列 Claude Code セッションを git worktree 上で実行',
    model: (name) => `モデル: ${name}`,
    defaultModel: 'CLI 既定',
  },
  footer: {
    autoMode: '自動モード',
    confirmMode: '確認モード',
    cycleHint: '(shift+tab で切替)',
  },
  command: {
    paletteTitle: 'コマンド',
    paletteEmpty: '一致するコマンドがありません',
    helpTitle: '利用可能なコマンド',
    unknown: (name) => (name ? `不明なコマンド: /${name}` : '不明なコマンドです'),
    help: 'コマンド一覧を表示',
    quit: 'codiva を終了',
    model: 'モデルを切り替え',
  },
};

const en: Messages = {
  list: {
    sessionCount: (n) => `${n} session${n === 1 ? '' : 's'}`,
    totalCost: (usd) => `total ${usd}`,
    emptyHint: 'Type an instruction and press Enter to start your first session.',
    promptPlaceholder: 'Describe what you want built…',
    helpComposer: 'Enter: submit · Shift+Enter: newline · Tab: list · Ctrl+C: quit',
    helpList:
      '↑↓: select · Enter/→: open detail · p: open PR · m: merge · d: discard · Tab/Esc: input',
    helpPending: 'Answer in the dialog · PgUp/PgDn: move selection · Tab: input',
    actionErrorLabel: 'Action error',
    mergePrompt: 'Merge into the base branch.',
    discardPrompt: 'Discard the worktree and branch.',
    confirmRun: 'Proceed?',
    busySuffix: '…running',
    moreAbove: (n) => `↑ ${n} more`,
    moreBelow: (n) => `↓ ${n} more`,
  },
  detail: {
    notFound: 'Session not found. Press Esc to go back.',
    progress: (done, total, active) => `Progress ${done}/${total}${active ? ` — ${active}` : ''}`,
    cost: (usd) => `Cost ${usd}`,
    errorLabel: 'error',
    changesTitle: (branch) => `Changes (${branch} vs base):`,
    noCommittedChanges: '(no committed changes)',
    uncommitted: (n) => `${n} uncommitted change${n === 1 ? '' : 's'}`,
    actionErrorLabel: 'Action error',
    followupPlaceholder: 'Enter a follow-up instruction…',
    scrollHint: (n) => `▲ Viewing older log — ${n} newer below (PgDn to go down)`,
    actionsTitle: 'Actions',
    mergePrompt: 'Merge into the base branch.',
    discardPrompt: 'Discard the worktree and branch.',
    confirmRun: 'Proceed?',
    busySuffix: '…running',
    mergeAction: 'Merge (--no-ff)',
    discardAction: 'Discard (remove worktree)',
    helpPending: 'Esc: back to list',
    helpActions: 'm/d: actions · Tab: input · Esc: back',
    helpInput: 'Enter: send · Shift+Enter: newline · PgUp/PgDn: log · Tab: actions · Esc: back',
  },
  badge: {
    creating: 'Preparing',
    running: 'Running',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: 'Awaiting permission',
    awaitingInput: 'Question',
    completed: 'Completed',
    failed: 'Failed',
    conflict: 'Conflict',
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
  model: {
    title: 'Select model',
    help: '↑↓: select · Enter: confirm · Esc: cancel',
    recommended: 'recommended',
    saved: (name) => `Model set to ${name} (applies to new sessions)`,
    names: {
      default: 'Default',
      opus: 'Opus',
      fable: 'Fable',
      sonnet: 'Sonnet',
      haiku: 'Haiku',
    },
    descriptions: {
      default: 'Use the CLI default model',
      opus: 'Opus 4.8 · Best for everyday, complex tasks',
      fable: 'Fable 5 · Most capable for your hardest, longest tasks',
      sonnet: 'Sonnet 5 · Efficient for routine tasks',
      haiku: 'Haiku 4.5 · Fastest for quick answers',
    },
  },
  app: {
    remainingWorktrees: (n) =>
      `codiva: ${n} worktree${n === 1 ? '' : 's'} left in place (your work is preserved):`,
  },
  notify: {
    needsInput: 'Needs your input',
    needsPermission: 'Awaiting permission',
    completed: 'Completed',
    failed: 'Failed',
  },
  banner: {
    subtitle: 'Parallel Claude Code sessions in git worktrees',
    model: (name) => `model: ${name}`,
    defaultModel: 'CLI default',
  },
  footer: {
    autoMode: 'auto mode on',
    confirmMode: 'confirm mode on',
    cycleHint: '(shift+tab to cycle)',
  },
  command: {
    paletteTitle: 'Commands',
    paletteEmpty: 'No matching command',
    helpTitle: 'Available commands',
    unknown: (name) => (name ? `Unknown command: /${name}` : 'Unknown command'),
    help: 'Show available commands',
    quit: 'Quit codiva',
    model: 'Switch the default model',
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
