import { describe, expect, it } from 'vitest';
import type { CodivaConfig, IgnoredFilesMode } from '@/core';
import { buildAgents, sessionOptionsFrom } from './build-manager';

describe('sessionOptionsFrom', () => {
  it('forwards the configured knobs verbatim', () => {
    const config: CodivaConfig = {
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'plan',
      maxBudgetUsd: 3,
    };
    expect(sessionOptionsFrom(config, 'Open a PR when done')).toEqual({
      model: 'claude-opus-4-8',
      effort: 'high',
      permissionMode: 'plan',
      maxBudgetUsd: 3,
      appendSystemPrompt: 'Open a PR when done',
      ignoredFiles: 'symlink',
    });
  });

  // `ignoredFiles` を渡し忘れると symlink 共有の注意書きが systemPrompt から消える
  // （= セッションが共有物だと知らずにビルドする）。`WorktreeManager` と同じ解決結果に
  // なることをここで固定する。
  it.each<[CodivaConfig, IgnoredFilesMode]>([
    [{}, 'symlink'],
    [{ ignoredFiles: 'symlink' }, 'symlink'],
    [{ ignoredFiles: 'copy' }, 'copy'],
    [{ ignoredFiles: 'none' }, 'none'],
    [{ copyIgnored: true }, 'copy'],
    [{ copyIgnored: false }, 'none'],
    [{ ignoredFiles: 'symlink', copyIgnored: true }, 'symlink'],
  ])('resolves the worktree ignored-files mode from %o', (config, expected) => {
    expect(sessionOptionsFrom(config).ignoredFiles).toBe(expected);
  });

  it('leaves an absent repo prompt undefined', () => {
    expect(sessionOptionsFrom({}).appendSystemPrompt).toBeUndefined();
  });
});

/**
 * アダプタの登録。ここが唯一の「provider の I/O を注入する場所」なので、
 * 足したはずのエージェントが `/agent` に出ない（= registry に載っていない）
 * 取り違えだけを安く固定する。実プロセスは起こさない。
 */
describe('buildAgents', () => {
  it('registers every implemented provider', () => {
    const agents = buildAgents({} as CodivaConfig, { repoRoot: process.cwd() });
    expect(Object.keys(agents).sort()).toEqual(['claude', 'codex', 'grok']);
    expect(agents.grok?.displayName).toBe('Grok');
    expect(agents.grok?.loginCommand).toBe('grok');
    // 許可・質問を上げられる provider として登録されている（Codex との違い）。
    expect(agents.grok?.capabilities.permissions).toBe(true);
    // TUI 内ログインの導線が生えている（`/login` と `/agent` の `l`）。
    expect(agents.grok?.login).toBeDefined();
  });
});
