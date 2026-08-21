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
 * 文言に差し込むエージェントの識別情報。将来 Claude 以外（Codex / Grok）の
 * セッションを扱えるようにするため、表示名とログインコマンドをカタログから
 * 追い出して引数にする。値の出所はアダプタ（`core/agent-ports.ts` の
 * `AgentAdapter`）で、カタログ側は「どう並べるか」だけを持つ。
 */
export interface AgentLabel {
  /** 表示名（例: 'Claude'）。SDK/CLI 由来の固有名詞なので翻訳しない。 */
  name: string;
  /** 再ログインに使う CLI コマンド名（例: 'claude'）。 */
  loginCommand: string;
}

/** 既定のエージェント表示情報（アダプタが分からないときのフォールバック）。 */
export const DEFAULT_AGENT_LABEL: AgentLabel = { name: 'Claude', loginCommand: 'claude' };

/**
 * アダプタから差し込み用のラベルを作る。**認証切れの案内は provider ごとに違う**
 * （Codex のセッションに「`claude` でログインし直して」と言ってはいけない）ので、
 * 文言を出す側は必ずセッションのエージェントからこれを引く。
 *
 * 引数は `AgentAdapter` の構造部分だけを受ける（`core/i18n.ts` を `agent-ports.ts`
 * から独立させたままにするため）。
 */
export function agentLabelOf(
  agent: { displayName: string; loginCommand: string } | undefined,
): AgentLabel {
  return agent
    ? { name: agent.displayName, loginCommand: agent.loginCommand }
    : DEFAULT_AGENT_LABEL;
}

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
    /** 選択中セッションの許可/質問ダイアログがキーを持つ間（dialog ゾーン）のヒント */
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
    /** 複数 PR を出したセッションの PR 行の見出し（`PR 2 件:` → `#12 · #13`） */
    prsLabel: (n: number) => string;
    changesTitle: (branch: string) => string;
    noCommittedChanges: string;
    uncommitted: (n: number) => string;
    /**
     * 追加指示の入力欄プレースホルダ（agent = このセッションを駆動しているエージェントの
     * 表示名）。詳細ビューはステータスヘッダを持たないので、「何で走っているか」を
     * 1 行も増やさずに出せる場所がここ。
     */
    followupPlaceholder: (agent: string) => string;
    scrollHint: (newerBelow: number) => string;
    actionsTitle: string;
    mergeAction: string;
    discardAction: string;
    /** セッションを一覧から完全に削除する操作（worktree/ブランチも消す） */
    removeAction: string;
    /**
     * 進行中のターンを中断できることの案内（`Ctrl+C`）。フォーカス横断の chord なので
     * フッタヒントではなく独立した行に出す（再開の `resume.oneKeyHint` と同じ扱い）。
     */
    cancelHint: string;
    /** 許可/質問ダイアログにフォーカスがあるとき（`dialog` ゾーン）のフッタヒント */
    helpPending: string;
    /**
     * 許可/質問待ちのまま会話ログを遡っているとき（`log` ゾーン）のフッタヒント。
     * 質問の背景を読んでから回答するためのゾーンなので、戻り方（Tab / Esc）を必ず出す。
     */
    helpLog: string;
    /**
     * `log` ゾーンのあいだ「表示だけ」になっているダイアログの中に出す案内。
     * 一覧の `permission.inactiveHelp`（↑↓ = セッション切替）は詳細では嘘になるので、
     * 共有コンポーネントへは view からこの文言を渡す。
     */
    dialogInactiveHelp: string;
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
    /** 1件削除の確認文（破棄と違い一覧の行も残らないことを伝える） */
    removePrompt: string;
    /** /clear の確認文。`n` = 消える件数（worktree とブランチも消えるので必ず確認する） */
    clearPrompt: (n: number) => string;
    /**
     * 一括再開の確認文。`n` = 対象件数、`auth` = そのうち認証切れの件数。
     * 認証切れには「ログインし直した」という指示文を送るので、まだログインして
     * いないなら先にログインするよう促す（0 件なら触れない = `agent` も出ない）。
     */
    resumeAllPrompt: (agent: AgentLabel, n: number, auth: number) => string;
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
    /**
     * 一覧の list ゾーンで、ダイアログが「表示だけされていて操作を受け付けない」ときの案内。
     * そこでは ↑↓ がセッション切替なので、回答へ戻るには Tab の輪
     * （composer → dialog → list）をもう一周させる。
     */
    inactiveHelp: string;
    /**
     * 選択肢がダイアログの高さ上限に収まらないとき、上/下に隠れている件数
     * （`core/choice-lines.ts` の `choiceView`）。↑↓ で送るとスクロールする。
     */
    moreAbove: (n: number) => string;
    moreBelow: (n: number) => string;
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
  /** エージェント選択ダイアログ（agent-select.tsx。/agent コマンドで開く） */
  agent: {
    /** ダイアログ見出し */
    title: string;
    /** ダイアログ下部の操作ヒント */
    help: string;
    /**
     * 切替の注意書き。provider 固有のセッションはまたげない（各 CLI が自分の
     * トランスクリプトを持つ）が、codiva が持っている会話ログは切替先へ写す
     * （`core/agent-handoff.ts`）。worktree はそのまま共有される。
     */
    warning: string;
    /** 今このセッションを駆動している行に付ける印（詳細ビュー） */
    current: string;
    /** 新規セッションの既定に選ばれている行に付ける印（一覧ビュー） */
    currentDefault: string;
    /** 一覧の `/agent` は「新規セッションの既定」を選ぶ、の注記（session 用 warning の代わり） */
    defaultHint: string;
    /** 検出中の行の説明 */
    checking: string;
    /** 導入済み + ログイン済み */
    ready: string;
    /** 導入済みだがログインが要る（cmd = ログインコマンド名） */
    notLoggedIn: (cmd: string) => string;
    /** 導入済みだがログイン状態を判定できなかった（keychain を見ないため） */
    loginUnknown: string;
    /** 未導入（cmd = 入れるべき CLI コマンド名） */
    notInstalled: (cmd: string) => string;
    /** どのエージェントも導入されていないときの一覧のセットアップ案内 */
    noneInstalled: string;
    /** 切替後のフッタ通知（name はエージェントの表示名） */
    switched: (name: string) => string;
    /** 既定を変えたときのフッタ通知（name はエージェントの表示名） */
    defaultSet: (name: string) => string;
    /** 切替できなかったとき（未対応・既に同じ・セッション未起動） */
    unavailable: string;
    /** そのエージェントが持たない機能を使おうとしたとき（name は表示名） */
    unsupported: (name: string) => string;
    /** `/agent` の行で `l` を押すとログインできる、のヒント */
    loginKey: string;
    /**
     * 会話ログの中の切替の区切り行（name は以降を担当するエージェントの表示名）。
     * どこからが別のエージェントの発言かを 1 行で示す。
     */
    logDivider: (name: string) => string;
  };
  /** TUI 内ログイン（login-dialog.tsx。`/login` と `/agent` の `l` で開く） */
  login: {
    /** 見出し（name = エージェント表示名） */
    title: (name: string) => string;
    /** 起動直後（URL がまだ出ていない）のプレースホルダ */
    starting: string;
    /** 認証 URL の前置き（クリック / 自動オープンで開く） */
    openUrl: string;
    /** デバイスコードの前置き（code = 表示するコード） */
    code: (code: string) => string;
    /** URL が出てから完了を待っている間の案内 */
    waiting: string;
    /** 成功（name = エージェント表示名） */
    succeeded: (name: string) => string;
    /** 失敗（name = エージェント表示名） */
    failed: (name: string) => string;
    /** 操作ヒント（実行中は中止、終了後は閉じる） */
    help: string;
    /** TUI 内ログインに対応していないエージェントを選んだとき（name = 表示名） */
    unsupported: (name: string) => string;
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
    needsLogin: (agent: AgentLabel) => string;
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
   * PR の立て直し（`/sync` / `/fix-ci` / `/recover`。判定は `core/pr-recovery.ts`）。
   *
   * `*Instruction` はセッションへ送る指示文で、ログにユーザー発話として残る
   * （`resume.instruction` と同じ扱いなので、AI 向けでもここに置いて翻訳する）。
   * 残りは操作結果を伝えるフッタ用の文言。
   */
  recover: {
    /** ベース取り込みで競合したときの指示（競合を worktree に残したまま渡す）。 */
    conflictInstruction: (base: string, files: readonly string[]) => string;
    /** 未コミットの変更があってマージを試みなかったときの指示（取り込みごと任せる）。 */
    dirtyInstruction: (base: string, files: readonly string[]) => string;
    /** CI が赤いときの指示（失敗したチェック名を添える）。 */
    ciInstruction: (branch: string, checks: readonly string[]) => string;
    /** 取り込んで push できた（エージェントを起こしていない）。 */
    synced: string;
    /** 取り込むものが無かった。 */
    upToDate: string;
    /** 競合／CI をセッションへ引き渡した。 */
    delegatedSync: string;
    delegatedCi: string;
    /** 立て直す理由が無い行で実行したとき。 */
    skipped: string;
    /** セッションが作業中で立て直せないとき（worktree を触らせない）。 */
    busySession: string;
    /** 一括立て直しの実行中。 */
    running: string;
    /** 一括実行の確認文（件数入り）。 */
    allPrompt: (sync: number, ci: number) => string;
    /** 立て直し対象があるときに常時出す案内。 */
    allHint: (n: number) => string;
    /** 一括実行後のフッタ通知（実際に走った件数）。 */
    allDone: (n: number) => string;
  };
  /**
   * 認証切れ（`needs_login`）の案内。エージェントの OAuth セッションが失効すると
   * セッションは何もできないので、「別ターミナルでそのエージェントの CLI に
   * ログインし直して r で再開する」という手順そのものを提示する。
   * エージェント名・コマンド名は `AgentLabel` で差し込む。
   */
  auth: {
    /** 一覧で needs_login 行を選択中のフッタヒント（再開キー r を含む）。 */
    listHint: (agent: AgentLabel) => string;
    /** ログイン手順の案内文（一覧・詳細で共有）。 */
    hint: (agent: AgentLabel) => string;
  };
  /** 起動バナー（banner.tsx） */
  banner: {
    /** 使用中モデルの表示（設定 model。未設定は CLI 既定）。プラン表示と同じ行に並ぶ。 */
    model: (name: string) => string;
    /**
     * 新規セッションを動かすエージェントの表示（`/agent` の既定）。名前はアダプタ由来の
     * 固有名詞なのでそのまま差し込む（モデル名と同じ扱い）。
     */
    agent: (name: string) => string;
    /** model 未設定時に表示するプレースホルダ（CLI 既定）。 */
    defaultModel: string;
    /**
     * プラン表示（`accountInfo()` 由来）。プラン名は SDK 由来の表示文字列なので
     * そのまま渡す（i18n の例外。モデル名と同じ扱い）。組織名は Team /
     * Enterprise のときだけ付く。
     */
    plan: (plan: string, organization?: string) => string;
    /**
     * 対象リポジトリが今チェックアウトしているブランチ（= 新しいセッションの分岐元・
     * マージ先）。detached HEAD では表示しない（`WorktreeManager.currentBranch()` が
     * undefined を返す）。
     */
    branch: (name: string) => string;
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
  /**
   * 下部モード行（status-footer.tsx）。プラン / 使用状況はヘッダ（`banner.usage.*`）の
   * 担当なので、フッタはモードとヒントだけを持つ。
   */
  footer: {
    autoMode: string;
    confirmMode: string;
    /**
     * 確認モードだが、駆動中のエージェントが許可要求を上げられない
     * （`AgentCapabilities.permissions === false`）ときのモード表示。ツールは
     * 確認なしで実行されるので、`confirmMode` のまま出すと嘘になる。
     */
    confirmModeUnsupported: string;
    cycleHint: string;
  };
  /** スラッシュコマンド（commands.ts / command-palette.tsx） */
  command: {
    /** 入力中に出るコマンドパレットの見出し */
    paletteTitle: string;
    /** 前方一致するコマンドが無いときの表示 */
    paletteEmpty: string;
    /** 端末が低くて全件描けないときに畳んだ件数（n は隠れている数） */
    paletteMore: (n: number) => string;
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
    /** /agent の説明 */
    agent: string;
    /** /login の説明 */
    login: string;
    /** /diff の説明 */
    diff: string;
    /** /prompt の説明 */
    prompt: string;
    /** /remove の説明 */
    remove: string;
    /** /clear の説明 */
    clear: string;
    /** /update の説明 */
    update: string;
    /** /sync の説明 */
    sync: string;
    /** /fix-ci の説明 */
    fixCi: string;
    /** /recover の説明 */
    recover: string;
    /** /config の説明 */
    config: string;
  };
  /**
   * 設定ダイアログ（config-select.tsx。/config で開く）。項目のラベルと 1 行説明は
   * 表示順（`core/config-items.ts` の `CONFIG_TOGGLES`）に並べてある。
   */
  config: {
    /** ダイアログ見出し */
    title: string;
    /** ダイアログ下部の操作ヒント */
    help: string;
    /** 「保存済み・反映は次回起動から」の注意書き（現状の項目は全部これに当たる） */
    restartHint: string;
    /** notifications: デスクトップ通知 */
    notifications: string;
    notificationsHelp: string;
    /** mouse: マウス操作 */
    mouse: string;
    mouseHelp: string;
    /** followOrigin: origin 追従 */
    followOrigin: string;
    followOriginHelp: string;
    /** autoPr: PR 自動作成 */
    autoPr: string;
    autoPrHelp: string;
    /** autoSync: 競合時にベースを自動取り込み */
    autoSync: string;
    autoSyncHelp: string;
    /** autoFixCi: CI 失敗時に自動で修正依頼 */
    autoFixCi: string;
    autoFixCiHelp: string;
    /** claudeSettingSources に 'user' を含めるか（= Claude Code のプラグインを読む） */
    claudePlugins: string;
    claudePluginsHelp: string;
    /** privacyWarning: 学習データ利用の警告 */
    privacyWarning: string;
    privacyWarningHelp: string;
    /** updateCheck: 起動時の更新確認 */
    updateCheck: string;
    updateCheckHelp: string;
    /** crashLog: クラッシュログ */
    crashLog: string;
    crashLogHelp: string;
    /** codexNetworkAccess: Codex のネットワーク許可 */
    codexNetworkAccess: string;
    codexNetworkAccessHelp: string;
  };
  /**
   * クラッシュ時に通常バッファ（シェルへ戻ったあとの画面）へ出す文言。
   * 端末を戻したあとに出すので、ここだけは Ink ではなく stderr に直接書かれる。
   */
  crash: {
    /** 見出し（予期せぬ終了の通知） */
    title: string;
    /** 書き出せたクラッシュログのパス */
    log: (path: string) => string;
    /** ログを書けなかったとき */
    logFailed: string;
    /** 端末表示が乱れたときの復旧コマンド案内 */
    reset: string;
    /** `--reset-terminal` を実行したときの完了メッセージ */
    resetDone: string;
  };
}

const ja: Messages = {
  list: {
    sessionCount: (n) => `${n} セッション`,
    totalCost: (usd) => `合計 ${usd}`,
    emptyHint: '指示を入力して Enter を押すと最初のセッションが始まります。',
    promptPlaceholder: '実装してほしいことを入力…',
    helpComposer:
      'Enter: 投入 ・ Shift+Enter: 改行 ・ Tab: 一覧へ ・ /exit: 終了 ・ Ctrl+U: 全消し ・ ↑↓: 履歴',
    helpList:
      '↑↓: 選択 ・ Enter/→: 詳細を開く ・ p: PR ・ m: マージ ・ d: 破棄 ・ x: 削除 ・ Tab/Esc: 入力へ',
    helpPending: 'ダイアログで回答 ・ Tab: 一覧へ（↑↓ でセッション切替） ・ Esc: 入力へ',
    moreAbove: (n) => `↑ 他 ${n} 件`,
    moreBelow: (n) => `↓ 他 ${n} 件`,
  },
  detail: {
    notFound: 'セッションが見つかりません。Esc で戻ります。',
    progress: (done, total, active) => `進捗 ${done}/${total}${active ? ` — ${active}` : ''}`,
    cost: (usd) => `コスト ${usd}`,
    errorLabel: 'エラー',
    prsLabel: (n) => `PR ${n} 件:`,
    changesTitle: (branch) => `変更（${branch} vs ベース）:`,
    noCommittedChanges: '（コミット済みの変更なし）',
    uncommitted: (n) => `未コミット ${n} 件`,
    followupPlaceholder: (agent) => `${agent} に追加の指示を入力…`,
    scrollHint: (n) => `▲ 過去ログを表示中 — 最新まで ${n} 行（↓/PgDn で下へ）`,
    actionsTitle: '操作',
    mergeAction: 'マージ（--no-ff）',
    discardAction: '破棄（worktree削除）',
    removeAction: '削除（一覧から消す）',
    cancelHint: 'Ctrl+C: 実行中のターンを中断（あとで再開できます）',
    helpPending: 'ダイアログで回答 ・ Tab: ログを遡る ・ Esc: 一覧へ戻る',
    helpLog: '↑↓/PgUp/PgDn: ログを遡る ・ Tab: 回答へ戻る ・ Esc: ダイアログへ',
    dialogInactiveHelp: '↑↓/PgUp/PgDn: ログを遡る ・ クリックで回答へ ・ Tab: 回答へ戻る',
    helpActions: 'm/d/x: 操作 ・ ↑↓/PgUp/PgDn: ログ ・ Tab: 入力へ ・ Esc: 戻る',
    helpInput:
      'Enter: 送信 ・ Shift+Enter: 改行 ・ ↑↓/PgUp/PgDn: ログ ・ Tab: 操作 ・ Esc: 一覧へ ・ Ctrl+U: 全消し',
  },
  action: {
    actionErrorLabel: '操作エラー',
    mergePrompt: 'ベースへマージします。',
    discardPrompt: 'worktree とブランチを破棄します。',
    removePrompt: 'このセッションを一覧から削除します（worktree とブランチも消えます）。',
    clearPrompt: (n) =>
      `完了したセッション ${n} 件を一覧から削除します（worktree とブランチも消えます）。`,
    resumeAllPrompt: (agent, n, auth) =>
      auth > 0
        ? `中断中の ${n} 件を続きから再開します（認証切れ ${auth} 件を含む — 先に別ターミナルで ${agent.loginCommand} にログインしてください）。`
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
      `↑↓/クリック: 選択 ・ ${multiSelect ? 'Space: トグル ・ ' : ''}Enter: 決定`,
    typeSomething: '自分で入力する',
    typePlaceholder: '回答を入力…',
    typingHelp: 'Enter: 送信 ・ Shift+Enter: 改行 ・ 空欄で Backspace: 選択に戻る',
    chatAboutThis: 'これについて相談する',
    chatMessage: 'ユーザーは選択肢を選ばず、この件について会話で相談することを選びました。',
    inactiveHelp: '↑↓: セッション切替 ・ クリックで回答へ ・ Tab: 入力へ',
    moreAbove: (n) => `↑ 他 ${n} 件`,
    moreBelow: (n) => `↓ 他 ${n} 件`,
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
  agent: {
    title: 'エージェントを選択',
    help: '↑↓: 選択 ・ Enter: 決定 ・ Esc: キャンセル',
    warning: '会話ログを切替先に引き継ぎます（worktree の変更もそのまま）',
    current: '使用中',
    currentDefault: '既定',
    defaultHint: '以降の新規セッションに適用されます',
    checking: '確認中…',
    ready: '使用できます',
    notLoggedIn: (cmd) => `未ログイン（\`${cmd} login\` を実行）`,
    loginUnknown: '導入済み',
    notInstalled: (cmd) => `未導入（\`${cmd}\` をインストール）`,
    noneInstalled:
      'コーディングエージェントが見つかりません。`claude` / `codex` / `grok` のいずれかを入れてログインしてください',
    switched: (name) => `${name} に切り替えました（次の指示から適用）`,
    defaultSet: (name) => `新規セッションの既定を ${name} にしました`,
    unavailable: 'エージェントを切り替えられませんでした',
    unsupported: (name) => `${name} はこの操作に対応していません`,
    loginKey: 'l: ログイン',
    logDivider: (name) => `── ここから ${name} ──`,
  },
  login: {
    title: (name) => `${name} にサインイン`,
    starting: 'サインインを開始しています…',
    openUrl: 'ブラウザで次の URL を開いてサインインしてください（クリックでも開けます）:',
    code: (code) => `コード: ${code}`,
    waiting: 'サインインの完了を待っています…',
    succeeded: (name) => `${name} にサインインしました`,
    failed: (name) => `${name} のサインインに失敗しました`,
    help: 'Esc: 中止 / 閉じる',
    unsupported: (name) => `${name} は codiva 内でのサインインに対応していません`,
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
    needsLogin: (agent) => `${agent.name} のログインが必要です`,
  },
  resume: {
    instruction: '接続が切れて中断しました。中断したところから作業を続けてください。',
    authInstruction:
      '認証切れで中断しました。ログインし直したので、中断したところから作業を続けてください。',
    listHint:
      '↑↓: 選択 ・ r/Ctrl+R: 再開 ・ Enter/→: 詳細 ・ m: マージ ・ d: 破棄 ・ x: 削除 ・ Tab/Esc: 入力へ',
    action: '再開（続行）',
    oneKeyHint: 'Ctrl+R: 中断したところから再開',
    allHint: (n) => `Ctrl+A: 中断中の ${n} 件をまとめて再開`,
  },
  recover: {
    conflictInstruction: (base, files) =>
      [
        `${base} をこのブランチへ取り込もうとしたところ、競合しました。競合はこの worktree に残してあります。`,
        files.length > 0 ? `競合ファイル: ${files.slice(0, 20).join(', ')}` : '',
        '双方の意図を確認したうえで競合を解決し、変更をコミットしてから origin へ push してください。',
        'どちらの変更を残すべきか判断できない場合は、勝手に片方を捨てずに質問してください。',
      ]
        .filter(Boolean)
        .join('\n'),
    dirtyInstruction: (base, files) =>
      [
        `この worktree に未コミットの変更があるため、${base} の取り込みを保留しました。`,
        `未コミット: ${files.slice(0, 20).join(', ')}`,
        `作業中の変更をコミット（または退避）してから ${base} を取り込み、競合があれば解決して origin へ push してください。`,
      ].join('\n'),
    ciInstruction: (branch, checks) =>
      [
        `ブランチ ${branch} の PR で CI が失敗しています。`,
        checks.length > 0
          ? `失敗したチェック: ${checks.join(' / ')}`
          : '失敗したチェック名は取得できませんでした。',
        '`gh pr checks` と `gh run view <run-id> --log-failed` で失敗ログを確認し、原因を修正してください。',
        '修正したらローカルで同じチェックを再現して通ることを確かめ、コミットして origin へ push してください。',
        'テストの期待値を書き換えて通すのではなく、失敗の原因そのものを直してください。',
      ].join('\n'),
    synced: 'ベースブランチを取り込んで push しました',
    upToDate: 'ベースブランチは取り込み済みです',
    delegatedSync: '競合の解決をセッションに依頼しました',
    delegatedCi: 'CI の修正をセッションに依頼しました',
    skipped: 'このセッションに立て直しは不要です',
    busySession: 'セッションが作業中です（終わってから実行してください）',
    running: 'PR を立て直しています…',
    allPrompt: (sync, ci) =>
      `PR が詰まっている ${sync + ci} 件を立て直します（競合 ${sync} 件 / CI 失敗 ${ci} 件）。`,
    allHint: (n) => `Ctrl+F: PR が詰まっている ${n} 件をまとめて立て直す`,
    allDone: (n) => `${n} 件の立て直しを実行しました`,
  },
  auth: {
    listHint: (agent) =>
      `認証切れ ・ 別ターミナルで ${agent.loginCommand} にログイン後 Ctrl+R: 再開 ・ Tab/Esc: 入力へ`,
    hint: (agent) =>
      `${agent.name} の認証が切れています。別のターミナルで ${agent.loginCommand} を起動して /login し、Ctrl+R で再開してください。`,
  },
  banner: {
    model: (name) => `モデル: ${name}`,
    agent: (name) => `エージェント: ${name}`,
    defaultModel: 'CLI 既定',
    plan: (plan, organization) =>
      organization ? `プラン: ${plan} (${organization})` : `プラン: ${plan}`,
    branch: (name) => `ブランチ: ${name}`,
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
    confirmModeUnsupported: '確認モード (非対応)',
    cycleHint: '(shift+tab で切替)',
  },
  command: {
    paletteTitle: 'コマンド',
    paletteEmpty: '一致するコマンドがありません',
    paletteMore: (n) => `他 ${n} 件（入力で絞り込めます）`,
    helpTitle: '利用可能なコマンド',
    unknown: (name) => (name ? `不明なコマンド: /${name}` : '不明なコマンドです'),
    help: 'コマンド一覧を表示',
    exit: 'codiva を終了',
    exitDetail: '詳細を閉じて一覧へ戻る',
    model: 'モデルを切り替え',
    agent: 'このセッションのエージェントを切り替え',
    login: 'エージェントに codiva 内でサインイン',
    diff: '変更差分サマリの表示を切り替え',
    prompt: 'リポジトリの追加指示を編集',
    remove: '選択中のセッションを削除（worktree とブランチも消す）',
    clear: '完了したセッションをまとめて削除（worktree とブランチも消す）',
    update: 'codiva の更新を確認して適用',
    sync: 'ベースブランチを取り込む（競合はセッションに解決させる）',
    fixCi: '失敗した CI をセッションに修正させる',
    recover: 'PR が詰まっているセッションをまとめて立て直す',
    config: '設定（ON/OFF）を変更する',
  },
  config: {
    title: '設定',
    help: '↑↓: 選択 ・ Enter / Space: 切替 ・ Esc: 閉じる',
    restartHint: '変更はすぐ保存されます（反映は次回の起動から）',
    notifications: 'デスクトップ通知',
    notificationsHelp: '質問・許可要求・完了のタイミングで OS の通知を出す',
    mouse: 'マウス操作',
    mouseHelp: 'クリックで選択・ドラッグで範囲コピー（端末側の選択は Shift+ドラッグ）',
    followOrigin: 'origin に追従して worktree を作る',
    followOriginHelp: 'セッション作成時に origin/<base> を取得し、その最新から枝を切る',
    autoPr: 'PR を自動で作る',
    autoPrHelp: '完了したセッションを push して draft PR を作り、チェックが緑なら ready にする',
    autoSync: '競合したらベースを自動で取り込む',
    autoSyncHelp: 'PR がベースと競合したら取り込む（解決をセッションに頼む時点で課金が走る）',
    autoFixCi: 'CI が落ちたら自動で修正を依頼する',
    autoFixCiHelp: '失敗したチェック名を添えてセッションに修正を指示する（課金が走る）',
    claudePlugins: 'Claude Code のプラグインを読み込む',
    claudePluginsHelp: '~/.claude/settings.json を読む（プラグインのほか hooks や権限設定も載る）',
    privacyWarning: '学習データ利用の警告を出す',
    privacyWarningHelp: 'Claude の学習データ利用が ON のときヘッダに注意行を出す',
    updateCheck: '起動時に更新を確認する',
    updateCheckHelp: 'npm レジストリに新しいバージョンがないか問い合わせる',
    crashLog: 'クラッシュログを残す',
    crashLogHelp: '異常終了したとき ~/.codiva/logs/ にレポートを書く',
    codexNetworkAccess: 'Codex のネットワークを許可する',
    codexNetworkAccessHelp: 'Codex のサンドボックスから外部へ通信できるようにする',
  },
  crash: {
    title: 'codiva が予期せず終了しました',
    log: (path) => `クラッシュログ: ${path}`,
    logFailed: 'クラッシュログを書き出せませんでした',
    reset: '端末の表示や入力が乱れている場合は `codiva --reset-terminal` を実行してください',
    resetDone: '端末のモード（マウス捕捉・代替スクリーン・カーソル）をリセットしました',
  },
};

const en: Messages = {
  list: {
    sessionCount: (n) => `${n} session${n === 1 ? '' : 's'}`,
    totalCost: (usd) => `total ${usd}`,
    emptyHint: 'Type an instruction and press Enter to start your first session.',
    promptPlaceholder: 'Describe what you want built…',
    helpComposer:
      'Enter: submit · Shift+Enter: newline · Tab: list · /exit: quit · Ctrl+U: clear · ↑↓: history',
    helpList:
      '↑↓: select · Enter/→: open detail · p: PR · m: merge · d: discard · x: remove · Tab/Esc: input',
    helpPending: 'Answer in the dialog · Tab: list (↑↓ switches sessions) · Esc: input',
    moreAbove: (n) => `↑ ${n} more`,
    moreBelow: (n) => `↓ ${n} more`,
  },
  detail: {
    notFound: 'Session not found. Press Esc to go back.',
    progress: (done, total, active) => `Progress ${done}/${total}${active ? ` — ${active}` : ''}`,
    cost: (usd) => `Cost ${usd}`,
    errorLabel: 'error',
    prsLabel: (n) => `${n} pull requests:`,
    changesTitle: (branch) => `Changes (${branch} vs base):`,
    noCommittedChanges: '(no committed changes)',
    uncommitted: (n) => `${n} uncommitted change${n === 1 ? '' : 's'}`,
    followupPlaceholder: (agent) => `Enter a follow-up instruction for ${agent}…`,
    scrollHint: (n) => `▲ Viewing older log — ${n} newer lines below (↓/PgDn to go down)`,
    actionsTitle: 'Actions',
    mergeAction: 'Merge (--no-ff)',
    discardAction: 'Discard (remove worktree)',
    removeAction: 'Remove (drop from the list)',
    cancelHint: 'Ctrl+C: interrupt the current turn (you can resume it later)',
    helpPending: 'Answer in the dialog · Tab: scroll back the log · Esc: back to list',
    helpLog: '↑↓/PgUp/PgDn: scroll the log · Tab: back to the dialog · Esc: dialog',
    dialogInactiveHelp: '↑↓/PgUp/PgDn: scroll the log · click to answer · Tab: back to the dialog',
    helpActions: 'm/d/x: actions · ↑↓/PgUp/PgDn: log · Tab: input · Esc: back',
    helpInput:
      'Enter: send · Shift+Enter: newline · ↑↓/PgUp/PgDn: log · Tab: actions · Esc: back · Ctrl+U: clear',
  },
  action: {
    actionErrorLabel: 'Action error',
    mergePrompt: 'Merge into the base branch.',
    discardPrompt: 'Discard the worktree and branch.',
    removePrompt: 'Remove this session from the list (its worktree and branch are deleted too).',
    clearPrompt: (n) =>
      `Remove ${n} finished session${n === 1 ? '' : 's'} from the list (worktrees and branches are deleted too).`,
    resumeAllPrompt: (agent, n, auth) =>
      auth > 0
        ? `Resume all ${n} interrupted sessions from where they stopped (${auth} need a login first — log in to ${agent.loginCommand} in another terminal).`
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
      `↑↓/click: select · ${multiSelect ? 'Space: toggle · ' : ''}Enter: confirm`,
    typeSomething: 'Type something.',
    typePlaceholder: 'Type your answer…',
    typingHelp: 'Enter: submit · Shift+Enter: newline · Backspace on empty: back to choices',
    chatAboutThis: 'Chat about this',
    chatMessage: 'The user chose to chat about this instead of picking an option.',
    inactiveHelp: '↑↓: switch sessions · click to answer · Tab: input',
    moreAbove: (n) => `↑ ${n} more`,
    moreBelow: (n) => `↓ ${n} more`,
  },
  model: {
    title: 'Select model',
    help: '↑↓: select · Enter: confirm · Esc: cancel',
    loading: 'Loading models…',
    defaultRow: 'Default (recommended)',
    saved: (name) => `Model set to ${name} (applies to new sessions)`,
  },
  agent: {
    title: 'Select agent',
    help: '↑↓: select · Enter: confirm · Esc: cancel',
    warning: 'The conversation log is handed to the new agent (worktree changes stay too)',
    current: 'in use',
    currentDefault: 'default',
    defaultHint: 'Applies to new sessions from now on',
    checking: 'Checking…',
    ready: 'Ready',
    notLoggedIn: (cmd) => `Not logged in (run \`${cmd} login\`)`,
    loginUnknown: 'Installed',
    notInstalled: (cmd) => `Not installed (install \`${cmd}\`)`,
    noneInstalled: 'No coding agent found. Install `claude`, `codex`, or `grok` and log in',
    switched: (name) => `Switched to ${name} (applies to the next instruction)`,
    defaultSet: (name) => `New sessions will use ${name}`,
    unavailable: 'Could not switch the agent',
    unsupported: (name) => `${name} does not support this`,
    loginKey: 'l: sign in',
    logDivider: (name) => `── ${name} from here ──`,
  },
  login: {
    title: (name) => `Sign in to ${name}`,
    starting: 'Starting sign-in…',
    openUrl: 'Open this URL in your browser to sign in (or click it):',
    code: (code) => `Code: ${code}`,
    waiting: 'Waiting for sign-in to complete…',
    succeeded: (name) => `Signed in to ${name}`,
    failed: (name) => `Sign-in to ${name} failed`,
    help: 'Esc: cancel / close',
    unsupported: (name) => `${name} does not support signing in from codiva`,
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
    needsLogin: (agent) => `${agent.name} login required`,
  },
  resume: {
    instruction:
      'The connection dropped and this session was interrupted. Continue from where you left off.',
    authInstruction:
      'This session stopped because authentication expired. I have logged back in — continue from where you left off.',
    listHint:
      '↑↓: select · r/Ctrl+R: resume · Enter/→: open detail · m: merge · d: discard · x: remove · Tab/Esc: input',
    action: 'Resume (continue)',
    oneKeyHint: 'Ctrl+R: resume from where it stopped',
    allHint: (n) => `Ctrl+A: resume all ${n} interrupted sessions`,
  },
  recover: {
    conflictInstruction: (base, files) =>
      [
        `Merging ${base} into this branch hit conflicts. The conflict markers are left in place in this worktree.`,
        files.length > 0 ? `Conflicted files: ${files.slice(0, 20).join(', ')}` : '',
        'Work out what both sides intended, resolve the conflicts, commit the result and push to origin.',
        'If you cannot tell which side should win, ask instead of silently discarding one of them.',
      ]
        .filter(Boolean)
        .join('\n'),
    dirtyInstruction: (base, files) =>
      [
        `This worktree has uncommitted changes, so merging ${base} was skipped.`,
        `Uncommitted: ${files.slice(0, 20).join(', ')}`,
        `Commit (or stash) your work in progress, merge ${base} in, resolve any conflicts and push to origin.`,
      ].join('\n'),
    ciInstruction: (branch, checks) =>
      [
        `CI is failing on the pull request for branch ${branch}.`,
        checks.length > 0
          ? `Failing checks: ${checks.join(' / ')}`
          : 'The failing check names could not be read.',
        'Inspect the failures with `gh pr checks` and `gh run view <run-id> --log-failed`, then fix the cause.',
        'Reproduce the same checks locally to confirm they pass, then commit and push to origin.',
        'Fix the underlying failure — do not rewrite test expectations just to make them green.',
      ].join('\n'),
    synced: 'Merged the base branch and pushed',
    upToDate: 'The base branch is already merged in',
    delegatedSync: 'Asked the session to resolve the conflicts',
    delegatedCi: 'Asked the session to fix CI',
    skipped: 'This session has nothing to recover',
    busySession: 'The session is still working (try again once it finishes)',
    running: 'Recovering pull requests…',
    allPrompt: (sync, ci) =>
      `Recover ${sync + ci} stuck pull request(s) (${sync} conflicting, ${ci} with failing CI).`,
    allHint: (n) => `Ctrl+F: recover all ${n} stuck pull request(s)`,
    allDone: (n) => `Started recovery for ${n} session(s)`,
  },
  auth: {
    listHint: (agent) =>
      `Login expired · log in to ${agent.loginCommand} in another terminal, then Ctrl+R: resume · Tab/Esc: input`,
    hint: (agent) =>
      `${agent.name} authentication expired. Run \`${agent.loginCommand}\` in another terminal, use /login, then press Ctrl+R to resume.`,
  },
  banner: {
    model: (name) => `Model: ${name}`,
    agent: (name) => `Agent: ${name}`,
    defaultModel: 'CLI default',
    plan: (plan, organization) =>
      organization ? `Plan: ${plan} (${organization})` : `Plan: ${plan}`,
    branch: (name) => `Branch: ${name}`,
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
    confirmModeUnsupported: 'confirm mode (n/a)',
    cycleHint: '(shift+tab to cycle)',
  },
  command: {
    paletteTitle: 'Commands',
    paletteEmpty: 'No matching command',
    paletteMore: (n) => `+${n} more (keep typing to filter)`,
    helpTitle: 'Available commands',
    unknown: (name) => (name ? `Unknown command: /${name}` : 'Unknown command'),
    help: 'Show available commands',
    exit: 'Quit codiva',
    exitDetail: 'Close the session view (back to the list)',
    model: 'Switch the model',
    agent: 'Switch the agent driving this session',
    login: 'Sign in to an agent from within codiva',
    diff: 'Toggle the changes summary',
    prompt: 'Edit the repository instructions',
    remove: 'Remove the selected session (worktree and branch deleted too)',
    clear: 'Remove every finished session (worktrees and branches deleted too)',
    update: 'Check for a codiva update and apply it',
    sync: 'Merge the base branch in (the session resolves any conflicts)',
    fixCi: 'Ask the session to fix its failing CI checks',
    recover: 'Recover every session whose pull request is stuck',
    config: 'Change the on/off settings',
  },
  config: {
    title: 'Settings',
    help: '↑↓: move ・ Enter / Space: toggle ・ Esc: close',
    restartHint: 'Saved right away (takes effect the next time codiva starts)',
    notifications: 'Desktop notifications',
    notificationsHelp: 'Notify on questions, permission requests and completion',
    mouse: 'Mouse support',
    mouseHelp: "Click to select, drag to copy (Shift+drag for the terminal's own selection)",
    followOrigin: 'Follow origin when creating worktrees',
    followOriginHelp: 'Fetch origin/<base> and branch from its latest commit',
    autoPr: 'Open pull requests automatically',
    autoPrHelp: 'Push finished sessions, open a draft PR, mark it ready once checks are green',
    autoSync: 'Merge the base in when a PR conflicts',
    autoSyncHelp: 'Take the base branch in; asking the session to resolve conflicts costs tokens',
    autoFixCi: 'Ask the session to fix failing CI',
    autoFixCiHelp: 'Send the failing check names to the session (costs tokens)',
    claudePlugins: 'Load Claude Code plugins',
    claudePluginsHelp: 'Read ~/.claude/settings.json (plugins, but also its hooks and permissions)',
    privacyWarning: 'Warn about training-data use',
    privacyWarningHelp: "Show a header notice while Claude's training-data setting is on",
    updateCheck: 'Check for updates on start',
    updateCheckHelp: 'Ask the npm registry whether a newer version exists',
    crashLog: 'Write crash logs',
    crashLogHelp: 'Leave a report in ~/.codiva/logs/ when codiva exits abnormally',
    codexNetworkAccess: 'Allow Codex network access',
    codexNetworkAccessHelp: 'Let the Codex sandbox reach the network',
  },
  crash: {
    title: 'codiva exited unexpectedly',
    log: (path) => `Crash log: ${path}`,
    logFailed: 'Could not write the crash log',
    reset: 'If the terminal looks or behaves oddly, run `codiva --reset-terminal`',
    resetDone: 'Reset the terminal modes (mouse reporting, alternate screen, cursor)',
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
