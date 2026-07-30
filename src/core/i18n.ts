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
    totalCost: (usd: string) => string;
    emptyHint: string;
    promptPlaceholder: string;
    /** 入力（コンポーザ）フォーカス時のフッタヒント */
    helpComposer: string;
    /** セッション一覧フォーカス時のフッタヒント */
    helpList: string;
    /** 選択中セッションの許可/質問ダイアログがキーを持つ間のヒント */
    helpPending: string;
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
    followupPlaceholder: string;
    scrollHint: (newerBelow: number) => string;
    actionsTitle: string;
    mergeAction: string;
    discardAction: string;
    helpPending: string;
    helpActions: string;
    helpInput: string;
  };
  /**
   * マージ/破棄の確認フロー（一覧・詳細で共有する ConfirmPrompt / エラー表示）。
   * 両ビューで同一だったキーをここに集約する。
   */
  action: {
    actionErrorLabel: string;
    mergePrompt: string;
    discardPrompt: string;
    /**
     * 一括再開の確認文。`n` = 対象件数、`auth` = そのうち認証切れの件数。
     * 認証切れには「ログインし直した」という指示文を送るので、まだログインして
     * いないなら先にログインするよう促す（0 件なら触れない）。
     */
    resumeAllPrompt: (n: number, auth: number) => string;
    confirmRun: string;
    busySuffix: string;
  };
  /** ステータスバッジ（progress-badge.tsx） */
  badge: {
    creating: string;
    running: string;
    step: (done: number, total: number) => string;
    awaitingPermission: string;
    awaitingInput: string;
    completed: string;
    interrupted: string;
    rateLimited: string;
    /** 認証切れで停止（`claude` へのログインが必要）。 */
    needsLogin: string;
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
    /** 「自分で入力する」選択肢（自由記述へ切り替える。Claude Code の Type something.） */
    typeSomething: string;
    /** 自由記述モードの入力欄プレースホルダ */
    typePlaceholder: string;
    /** 自由記述モードの操作ヒント */
    typingHelp: string;
    /** 質問をスキップして会話に戻る選択肢（Chat about this） */
    chatAboutThis: string;
    /** 「相談する」を選んだときにツールへ返す拒否理由（モデルに伝わる） */
    chatMessage: string;
  };
  /** モデル選択ダイアログ（model-select.tsx。/model コマンドで開く） */
  model: {
    /** ダイアログ見出し */
    title: string;
    /** ダイアログ下部の操作ヒント */
    help: string;
    /** カタログ取得中のプレースホルダ */
    loading: string;
    /**
     * 「CLI 既定を使う」行のラベル。モデル名と違いこれは codiva 自身の概念
     * （= `--model` を渡さない）なので、SDK の英語ではなくカタログから引く。
     */
    defaultRow: string;
    /** 選択確定後のフッタ通知（name は選んだモデルの表示名） */
    saved: (name: string) => string;
  };
  /** リポジトリ追加指示エディタ（repo-prompt-editor.tsx。/prompt コマンドで開く） */
  prompt: {
    /** エディタ見出し */
    title: string;
    /** エディタ下部の操作ヒント（保存/改行/キャンセル） */
    help: string;
    /** 空のときのプレースホルダ */
    placeholder: string;
  };
  /** デスクトップ通知（notify.ts） */
  notify: {
    needsInput: string;
    needsPermission: string;
    completed: string;
    rateLimited: string;
    failed: string;
    /** 通信断でセッションが中断された（再開可能）ときの通知。 */
    interrupted: string;
    /** 認証切れで停止した（ログインが必要な）ときの通知。 */
    needsLogin: string;
  };
  /**
   * 中断されたセッションの再開（continue）。通信断で `interrupted` になった、または
   * 使用量制限で `rate_limited` になったセッションを続行するためのアクション。
   */
  resume: {
    /** 再開時に Claude へ送る指示文（中断箇所からの続行を促す）。ログにユーザー発話として残る。 */
    instruction: string;
    /**
     * 認証切れ（`needs_login`）から再開するときに Claude へ送る指示文。
     * 「接続が切れた」ではなく「認証が切れた → 再ログイン済み」を伝える。
     */
    authInstruction: string;
    /** 一覧で再開可能なセッションを選択中のフッタヒント。 */
    listHint: string;
    /** 詳細ビューの操作パネルに出す再開アクションのラベル。 */
    action: string;
    /**
     * 再開可能なセッションを見ているときに常時出す一押し再開の案内（一覧・詳細共通）。
     * フォーカスや操作パネルの状態に関係なく効くキーなので、フッタヒントではなく
     * 独立した行として出す（認証切れの `auth.hint` と同じ扱い）。
     */
    oneKeyHint: string;
    /** 再開可能なセッションが2件以上あるときに出す一括再開の案内（件数入り）。 */
    allHint: (n: number) => string;
  };
  /**
   * 認証切れ（`needs_login`）の案内。Claude の OAuth セッションが失効すると
   * セッションは何もできないので、「別ターミナルで `claude` にログインし直して
   * r で再開する」という手順そのものを提示する。
   */
  auth: {
    /** 一覧で needs_login 行を選択中のフッタヒント（再開キー r を含む）。 */
    listHint: string;
    /** ログイン手順の案内文（一覧・詳細で共有）。 */
    hint: string;
  };
  /** 起動バナー（banner.tsx） */
  banner: {
    /** 使用中モデルの表示（設定 model。未設定は CLI 既定）。プラン表示と同じ行に並ぶ。 */
    model: (name: string) => string;
    /** model 未設定時に表示するプレースホルダ（CLI 既定）。 */
    defaultModel: string;
    /**
     * プラン表示（`accountInfo()` 由来）。プラン名は SDK 由来の表示文字列なので
     * そのまま渡す（i18n の例外。モデル名と同じ扱い）。組織名は Team /
     * Enterprise のときだけ付く。
     */
    plan: (plan: string, organization?: string) => string;
    /**
     * claude.ai サブスクリプションの使用リミット表示（SDK の rate_limit_event 由来）。
     * ウィンドウ見出しのキーは core の RateLimitLabelKey と一致させる。
     */
    usage: {
      /** セクション先頭のラベル（「使用状況」）。 */
      heading: string;
      /** 5時間枠（現在のセッション）の見出し。 */
      session: string;
      /** 週次枠の見出し。 */
      week: string;
      /** 週次枠（Opus 専用）の見出し。 */
      weekOpus: string;
      /** 週次枠（Sonnet 専用）の見出し。 */
      weekSonnet: string;
      /** 追加利用（overage）枠の見出し。 */
      overage: string;
      /** リセットまでの残り時間（日・時・分）。 */
      resetsIn: (days: number, hours: number, minutes: number) => string;
    };
    /**
     * 学習データ利用（claude.ai の「Help improve our AI models」）が ON と判定された
     * ときだけ出す注意行。判定できないときは何も出さない（`core/privacy.ts`）。
     */
    privacy: {
      /** 見出し（ON である事実と影響）。 */
      warning: string;
      /** 変更方法の案内（URL を含む）。 */
      hint: string;
    };
  };
  /** アップデート通知（banner.tsx の 1 行 + /update ダイアログ） */
  update: {
    /** バナー行: 新しいバージョンが出ている。 */
    available: (latest: string) => string;
    /** バナー行に添える案内（`/update` を促す）。 */
    availableHint: string;
    /** /update ダイアログの見出し。 */
    title: string;
    /** レジストリへの問い合わせ中。 */
    checking: string;
    /** すでに最新だった。 */
    upToDate: (current: string) => string;
    /** 最新バージョンを取得できなかった（オフライン・レジストリ障害など）。 */
    unavailable: string;
    /** 更新があり、実行してよいか尋ねる（実行するコマンドを見せる）。 */
    confirm: (latest: string, command: string) => string;
    /** 更新はあるが codiva 側で実行しない（インストール経路が不確実）ので手順を出す。 */
    manual: (latest: string, command: string) => string;
    /** npx 実行中: インストールが無いので次回起動でそのまま最新になる。 */
    npx: (latest: string) => string;
    /** 更新コマンドの実行中。 */
    installing: string;
    /** 実行中の閉じ方（更新自体は続く）。 */
    installingHint: string;
    /** 稼働中セッションがある状態で更新するときの警告。 */
    activeWarning: (count: number) => string;
    /** 更新完了（再起動を促す）。 */
    installed: (latest: string) => string;
    /** 更新コマンドが失敗した（detail は npm の stderr 由来）。 */
    failed: (detail: string) => string;
    /** 失敗したが理由が取れなかった。 */
    failedUnknown: string;
    /** ダイアログの閉じ方（任意キー）。 */
    dismiss: string;
  };
  /** 下部モード行（status-footer.tsx） */
  footer: {
    autoMode: string;
    confirmMode: string;
    cycleHint: string;
    /** ステータスバーの使用状況セグメント（枠の短縮見出し。キーは RateLimitLabelKey と一致）。 */
    usage: {
      session: string;
      week: string;
      weekOpus: string;
      weekSonnet: string;
      overage: string;
      /** 使用率が不明な枠（SDK が utilization を送らない）で残り時間だけ出すときの前置き。 */
      resetsInShort: (days: number, hours: number, minutes: number) => string;
    };
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
    /** /exit の説明（一覧ビュー = アプリ終了） */
    exit: string;
    /** /exit の説明（詳細ビュー = 一覧へ戻る。ビューで意味が変わるため別キー） */
    exitDetail: string;
    /** /model の説明 */
    model: string;
    /** /diff の説明 */
    diff: string;
    /** /prompt の説明 */
    prompt: string;
    /** /clear の説明 */
    clear: string;
    /** /update の説明 */
    update: string;
  };
}

const ja: Messages = {
  list: {
    sessionCount: (n) => `${n} セッション`,
    totalCost: (usd) => `合計 ${usd}`,
    emptyHint: '指示を入力して Enter を押すと最初のセッションが始まります。',
    promptPlaceholder: '実装してほしいことを入力…',
    helpComposer: 'Enter: 投入 ・ Shift+Enter: 改行 ・ Tab: 一覧へ ・ /exit: 終了',
    helpList:
      '↑↓: 選択 ・ Enter/→: 詳細を開く ・ p: PRを開く ・ m: マージ ・ d: 破棄 ・ Tab/Esc: 入力へ',
    helpPending: 'ダイアログで回答 ・ PgUp/PgDn: 選択移動 ・ Tab: 入力へ',
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
    followupPlaceholder: '追加の指示を入力…',
    scrollHint: (n) => `▲ 過去ログを表示中 — 最新まで ${n} 行（↓/PgDn で下へ）`,
    actionsTitle: '操作',
    mergeAction: 'マージ（--no-ff）',
    discardAction: '破棄（worktree削除）',
    helpPending: 'Esc: 一覧へ戻る',
    helpActions: 'm/d: 操作 ・ ↑↓/PgUp/PgDn: ログ ・ Tab: 入力へ ・ Esc: 戻る',
    helpInput: 'Enter: 送信 ・ Shift+Enter: 改行 ・ ↑↓/PgUp/PgDn: ログ ・ Tab: 操作 ・ Esc: 一覧へ',
  },
  action: {
    actionErrorLabel: '操作エラー',
    mergePrompt: 'ベースへマージします。',
    discardPrompt: 'worktree とブランチを破棄します。',
    resumeAllPrompt: (n, auth) =>
      auth > 0
        ? `中断中の ${n} 件を続きから再開します（認証切れ ${auth} 件を含む — 先に別ターミナルで claude にログインしてください）。`
        : `中断中の ${n} 件を続きから再開します。`,
    confirmRun: '実行しますか？',
    busySuffix: '…実行中',
  },
  badge: {
    creating: '準備中',
    running: '実行中',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: '許可待ち',
    awaitingInput: '質問あり',
    completed: '完了',
    interrupted: '中断',
    rateLimited: 'レート制限',
    needsLogin: 'ログイン必要',
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
    typeSomething: '自分で入力する',
    typePlaceholder: '回答を入力…',
    typingHelp: 'Enter: 送信 ・ 空欄で Backspace: 選択に戻る',
    chatAboutThis: 'これについて相談する',
    chatMessage: 'ユーザーは選択肢を選ばず、この件について会話で相談することを選びました。',
  },
  // モデル名・説明文はここに持たない。Claude Code のカタログ（英語）をそのまま
  // 出すのが唯一の出所という設計判断（core/models.ts 参照）。翻訳するとモデル追加
  // ごとにカタログ更新が必要になり、直書きの陳腐化がここへ移るだけになる。
  model: {
    title: 'モデルを選択',
    help: '↑↓: 選択 ・ Enter: 決定 ・ Esc: キャンセル',
    loading: 'モデル一覧を取得中…',
    defaultRow: 'デフォルト（推奨）',
    saved: (name) => `モデルを ${name} に変更しました（以降の新規セッションに適用）`,
  },
  prompt: {
    title: 'リポジトリの追加指示（.codiva/prompt.md）',
    help: 'Enter: 保存 ・ Shift+Enter: 改行 ・ Esc: キャンセル（空で保存すると削除）',
    placeholder: '例）作業が終わったらテストを実行し、PR を作成してください',
  },
  notify: {
    needsInput: '質問があります',
    needsPermission: '許可を待っています',
    completed: '完了しました',
    rateLimited: 'レート制限に達しました',
    failed: '失敗しました',
    interrupted: '接続が中断されました（再開できます）',
    needsLogin: 'Claude のログインが必要です',
  },
  resume: {
    instruction: '接続が切れて中断しました。中断したところから作業を続けてください。',
    authInstruction:
      '認証切れで中断しました。ログインし直したので、中断したところから作業を続けてください。',
    listHint:
      '↑↓: 選択 ・ r/Ctrl+R: 再開 ・ Enter/→: 詳細 ・ m: マージ ・ d: 破棄 ・ Tab/Esc: 入力へ',
    action: '再開（続行）',
    oneKeyHint: 'Ctrl+R: 中断したところから再開',
    allHint: (n) => `Ctrl+A: 中断中の ${n} 件をまとめて再開`,
  },
  auth: {
    listHint: '認証切れ ・ 別ターミナルで claude にログイン後 Ctrl+R: 再開 ・ Tab/Esc: 入力へ',
    hint: 'Claude の認証が切れています。別のターミナルで claude を起動して /login し、Ctrl+R で再開してください。',
  },
  banner: {
    model: (name) => `モデル: ${name}`,
    defaultModel: 'CLI 既定',
    plan: (plan, organization) =>
      organization ? `プラン: ${plan} (${organization})` : `プラン: ${plan}`,
    usage: {
      heading: '使用状況',
      session: '現在のセッション',
      week: '今週',
      weekOpus: '今週 (Opus)',
      weekSonnet: '今週 (Sonnet)',
      overage: '追加利用',
      resetsIn: (days, hours, minutes) => {
        const when =
          days > 0
            ? `${days}日${hours}時間`
            : hours > 0
              ? `${hours}時間${minutes}分`
              : `${minutes}分`;
        return `${when}後にリセット`;
      },
    },
    privacy: {
      warning: '学習データ利用が ON です（会話がモデル改善に使われる場合があります）',
      hint: '変更: https://claude.ai/settings/data-privacy-controls',
    },
  },
  update: {
    available: (latest) => `新しいバージョン v${latest} が利用できます`,
    availableHint: '/update で更新',
    title: 'アップデート',
    checking: '最新バージョンを確認中…',
    upToDate: (current) => `v${current} は最新です`,
    unavailable: '最新バージョンを確認できませんでした（オフラインの可能性があります）',
    confirm: (latest, command) => `v${latest} に更新します: ${command}`,
    manual: (latest, command) => `v${latest} が利用できます。手動で実行してください: ${command}`,
    npx: (latest) => `v${latest} が利用できます。npx 実行なので次回起動時に最新が使われます`,
    installing: '更新中… (npm install)',
    installingHint: 'Esc で閉じる（更新はそのまま続きます）',
    activeWarning: (count) =>
      `稼働中のセッションが ${count} 件あります。更新はセッション終了後を推奨します`,
    installed: (latest) => `v${latest} に更新しました。codiva を再起動すると反映されます`,
    failed: (detail) => `更新に失敗しました: ${detail}`,
    failedUnknown: '更新に失敗しました',
    dismiss: '任意のキーで閉じる',
  },
  footer: {
    autoMode: '自動モード',
    confirmMode: '確認モード',
    cycleHint: '(shift+tab で切替)',
    usage: {
      session: '5時間',
      week: '今週',
      weekOpus: '今週Opus',
      weekSonnet: '今週Sonnet',
      overage: '追加',
      resetsInShort: (days, hours, minutes) =>
        days > 0
          ? `残り${days}日${hours}時間`
          : hours > 0
            ? `残り${hours}時間${minutes}分`
            : `残り${minutes}分`,
    },
  },
  command: {
    paletteTitle: 'コマンド',
    paletteEmpty: '一致するコマンドがありません',
    helpTitle: '利用可能なコマンド',
    unknown: (name) => (name ? `不明なコマンド: /${name}` : '不明なコマンドです'),
    help: 'コマンド一覧を表示',
    exit: 'codiva を終了',
    exitDetail: '詳細を閉じて一覧へ戻る',
    model: 'モデルを切り替え',
    diff: '変更差分サマリの表示を切り替え',
    prompt: 'リポジトリの追加指示を編集',
    clear: '完了したセッションを一覧から消去（履歴は残る）',
    update: 'codiva の更新を確認して適用',
  },
};

const en: Messages = {
  list: {
    sessionCount: (n) => `${n} session${n === 1 ? '' : 's'}`,
    totalCost: (usd) => `total ${usd}`,
    emptyHint: 'Type an instruction and press Enter to start your first session.',
    promptPlaceholder: 'Describe what you want built…',
    helpComposer: 'Enter: submit · Shift+Enter: newline · Tab: list · /exit: quit',
    helpList:
      '↑↓: select · Enter/→: open detail · p: open PR · m: merge · d: discard · Tab/Esc: input',
    helpPending: 'Answer in the dialog · PgUp/PgDn: move selection · Tab: input',
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
    followupPlaceholder: 'Enter a follow-up instruction…',
    scrollHint: (n) => `▲ Viewing older log — ${n} newer lines below (↓/PgDn to go down)`,
    actionsTitle: 'Actions',
    mergeAction: 'Merge (--no-ff)',
    discardAction: 'Discard (remove worktree)',
    helpPending: 'Esc: back to list',
    helpActions: 'm/d: actions · ↑↓/PgUp/PgDn: log · Tab: input · Esc: back',
    helpInput: 'Enter: send · Shift+Enter: newline · ↑↓/PgUp/PgDn: log · Tab: actions · Esc: back',
  },
  action: {
    actionErrorLabel: 'Action error',
    mergePrompt: 'Merge into the base branch.',
    discardPrompt: 'Discard the worktree and branch.',
    resumeAllPrompt: (n, auth) =>
      auth > 0
        ? `Resume all ${n} interrupted sessions from where they stopped (${auth} need a login first — log in to claude in another terminal).`
        : `Resume all ${n} interrupted sessions from where they stopped.`,
    confirmRun: 'Proceed?',
    busySuffix: '…running',
  },
  badge: {
    creating: 'Preparing',
    running: 'Running',
    step: (done, total) => `Step ${done}/${total}`,
    awaitingPermission: 'Awaiting permission',
    awaitingInput: 'Question',
    completed: 'Completed',
    interrupted: 'Interrupted',
    rateLimited: 'Rate limited',
    needsLogin: 'Login required',
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
    typeSomething: 'Type something.',
    typePlaceholder: 'Type your answer…',
    typingHelp: 'Enter: submit · Backspace on empty: back to choices',
    chatAboutThis: 'Chat about this',
    chatMessage: 'The user chose to chat about this instead of picking an option.',
  },
  model: {
    title: 'Select model',
    help: '↑↓: select · Enter: confirm · Esc: cancel',
    loading: 'Loading models…',
    defaultRow: 'Default (recommended)',
    saved: (name) => `Model set to ${name} (applies to new sessions)`,
  },
  prompt: {
    title: 'Repository instructions (.codiva/prompt.md)',
    help: 'Enter: save · Shift+Enter: newline · Esc: cancel (save empty to clear)',
    placeholder: 'e.g. When you finish, run the tests and open a PR',
  },
  notify: {
    needsInput: 'Needs your input',
    needsPermission: 'Awaiting permission',
    completed: 'Completed',
    rateLimited: 'Rate limit reached',
    failed: 'Failed',
    interrupted: 'Connection interrupted (resumable)',
    needsLogin: 'Claude login required',
  },
  resume: {
    instruction:
      'The connection dropped and this session was interrupted. Continue from where you left off.',
    authInstruction:
      'This session stopped because authentication expired. I have logged back in — continue from where you left off.',
    listHint:
      '↑↓: select · r/Ctrl+R: resume · Enter/→: open detail · m: merge · d: discard · Tab/Esc: input',
    action: 'Resume (continue)',
    oneKeyHint: 'Ctrl+R: resume from where it stopped',
    allHint: (n) => `Ctrl+A: resume all ${n} interrupted sessions`,
  },
  auth: {
    listHint:
      'Login expired · log in to claude in another terminal, then Ctrl+R: resume · Tab/Esc: input',
    hint: 'Claude authentication expired. Run `claude` in another terminal, use /login, then press Ctrl+R to resume.',
  },
  banner: {
    model: (name) => `Model: ${name}`,
    defaultModel: 'CLI default',
    plan: (plan, organization) =>
      organization ? `Plan: ${plan} (${organization})` : `Plan: ${plan}`,
    usage: {
      heading: 'Usage',
      session: 'Current session',
      week: 'This week',
      weekOpus: 'This week (Opus)',
      weekSonnet: 'This week (Sonnet)',
      overage: 'Overage',
      resetsIn: (days, hours, minutes) => {
        const when =
          days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        return `resets in ${when}`;
      },
    },
    privacy: {
      warning: 'Model-improvement data sharing is ON (conversations may be used for training)',
      hint: 'Change it at https://claude.ai/settings/data-privacy-controls',
    },
  },
  update: {
    available: (latest) => `Update available: v${latest}`,
    availableHint: 'run /update',
    title: 'Update',
    checking: 'Checking for the latest version…',
    upToDate: (current) => `v${current} is the latest version`,
    unavailable: 'Could not check the latest version (you may be offline)',
    confirm: (latest, command) => `Update to v${latest}: ${command}`,
    manual: (latest, command) => `v${latest} is available. Run it yourself: ${command}`,
    npx: (latest) => `v${latest} is available. Running via npx, so the next run picks it up`,
    installing: 'Updating… (npm install)',
    installingHint: 'press Esc to close (the update keeps running)',
    activeWarning: (count) =>
      `${count} session(s) still running — updating after they finish is recommended`,
    installed: (latest) => `Updated to v${latest}. Restart codiva to use it`,
    failed: (detail) => `Update failed: ${detail}`,
    failedUnknown: 'Update failed',
    dismiss: 'press any key to close',
  },
  footer: {
    autoMode: 'auto mode on',
    confirmMode: 'confirm mode on',
    cycleHint: '(shift+tab to cycle)',
    usage: {
      session: '5h',
      week: 'week',
      weekOpus: 'week Opus',
      weekSonnet: 'week Sonnet',
      overage: 'overage',
      resetsInShort: (days, hours, minutes) =>
        days > 0
          ? `${days}d ${hours}h left`
          : hours > 0
            ? `${hours}h ${minutes}m left`
            : `${minutes}m left`,
    },
  },
  command: {
    paletteTitle: 'Commands',
    paletteEmpty: 'No matching command',
    helpTitle: 'Available commands',
    unknown: (name) => (name ? `Unknown command: /${name}` : 'Unknown command'),
    help: 'Show available commands',
    exit: 'Quit codiva',
    exitDetail: 'Close the session view (back to the list)',
    model: 'Switch the model',
    diff: 'Toggle the changes summary',
    prompt: 'Edit the repository instructions',
    clear: 'Clear finished sessions from the list (history is kept)',
    update: 'Check for a codiva update and apply it',
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
