import type { AgentEvent } from './agent-events';
import type { EffortLevel, PermissionMode } from './config';
import type { AgentId, AgentStopCause, PermissionRequest } from './types';

/**
 * コーディングエージェントの DI 境界。
 *
 * 境界をここ（1 ターンぶんのストリーム）に引いているのは、`SessionManager` から上
 * （UI・永続化・PR 自動化・worktree・通知）が既に `SessionHandle` 越しにしか
 * セッションを触っておらず、**エージェント非依存だから**。逆に Claude Agent SDK の
 * `query()` 署名（`AsyncIterable<SDKUserMessage>` + `Options` + `canUseTool` +
 * control request）を共通 IF にすると、全 provider が Claude の制御モデルを
 * 模倣する羽目になる。
 *
 * アダプタの責務は 3 つだけ:
 *   1. provider のストリームを開く（`open`）
 *   2. provider のメッセージを `AgentEvent[]` へ写す（`AgentRun` が yield する）
 *   3. provider 固有の失敗文言を `AgentStopCause` へ分類する（`classifyError`）
 *
 * 状態の畳み込み・ログの上限・完了ゲートは `core/agent-events.ts` の
 * `applyAgentEvent` が全 provider 共通で持つ。
 */

/**
 * 許可要求への回答。SDK の `PermissionResult` をそのまま core へ持ち込まない
 * ための自前型（`PermissionRequest` が既に自前型なので対にする）。provider 形への
 * 写像は各アダプタが行う。
 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** allow のとき、ツールへ渡す（必要なら書き換えた）入力。 */
  input?: Record<string, unknown>;
  /** deny のとき、エージェントへ返す理由。 */
  message?: string;
}

/**
 * そのエージェントが何をできるか。UI はこれを見て段階的に縮退する
 * （持たない機能のキー操作・表示を出さない）。**セッション途中で切り替えると
 * 変わりうる**ので、UI 側は固定値として持たずアダプタから引く。
 */
export interface AgentCapabilities {
  /** ツール実行の許可をユーザーへ上げられる（許可ダイアログ・質問ダイアログ）。 */
  permissions: boolean;
  /** 進行中ターンの中断（詳細ビューの `Ctrl+C`）。 */
  interrupt: boolean;
  /** セッション中のモデル切替（`/model`）。 */
  setModel: boolean;
  /** 過去の会話を継続できる（`resume`）。false なら切替や再起動で文脈が切れる。 */
  resume: boolean;
  /** 選択できるモデルの一覧を取れる（`/model` の選択肢）。 */
  modelCatalog: boolean;
  /** アカウント全体の使用状況を報告する（ヘッダのゲージ）。 */
  usage: boolean;
  /** ターンのコスト（USD）を報告する。 */
  cost: boolean;
  /** CLI 側のトランスクリプトから会話ログを復元できる。 */
  transcript: boolean;
}

/** 1 ターンぶんの起動オプション。provider ごとに解釈は違ってよい（無視も可）。 */
export interface AgentRunOptions {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  maxBudgetUsd?: number;
  /** worktree の環境説明 + リポジトリ追加指示（`core/system-prompt.ts`）。 */
  systemPrompt?: string;
}

/** `AgentAdapter.open` への入力。 */
export interface AgentRunRequest {
  /** セッションの worktree。 */
  cwd: string;
  /** ユーザー発話のストリーム（追加指示が随時流れ込む）。 */
  prompt: AsyncIterable<string>;
  /**
   * 継続する provider 側セッション id。**その provider が過去に発行したもの**を渡す
   * （`SessionState.agentSessions`）。別 provider の id を渡してはいけない。
   */
  resume?: string;
  options: AgentRunOptions;
  /**
   * 許可/質問をユーザーへ上げる。`id` は `Session` が採番するのでアダプタは渡さない。
   * 解決するまでエージェントはブロックされてよい。
   */
  requestPermission: (request: Omit<PermissionRequest, 'id'>) => Promise<PermissionDecision>;
  abortController: AbortController;
}

/**
 * 開いている 1 本のエージェントストリーム。`Query` の中立版。
 * `interrupt` / `setModel` は capability が false の provider では省略してよい。
 */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  interrupt?(): Promise<void>;
  setModel?(model: string | undefined): Promise<void> | void;
}

/**
 * 1 つのコーディングエージェント。`SessionManager` はこれを差し替えるだけで
 * provider を切り替えられる（**セッション途中の切替**は `Session.setAgent`）。
 */
export interface AgentAdapter {
  readonly id: AgentId;
  /** 画面に出す名前（'Claude' / 'Codex' / 'Grok'）。固有名詞なので翻訳しない。 */
  readonly displayName: string;
  /** 再ログインに使う CLI コマンド名（認証切れの案内文に差し込む）。 */
  readonly loginCommand: string;
  readonly capabilities: AgentCapabilities;
  /** ストリームを開く。復帰（resume）も同じ経路で、`request.resume` で区別する。 */
  open(request: AgentRunRequest): AgentRun;
  /**
   * ストリームが throw した/文字列でしか届かない失敗を分類する。未実装なら
   * `failed` 扱い。ここが provider 固有の文言知識の置き場所。
   */
  classifyError?(text: string): AgentStopCause;
  /** 指示文から短いタイトルを作る（省略可・best-effort）。 */
  generateTitle?(prompt: string): Promise<string | null | undefined>;
}

/** capability を全部 false にした素の値（新しいアダプタの出発点）。 */
export const NO_CAPABILITIES: AgentCapabilities = {
  permissions: false,
  interrupt: false,
  setModel: false,
  resume: false,
  modelCatalog: false,
  usage: false,
  cost: false,
  transcript: false,
};
