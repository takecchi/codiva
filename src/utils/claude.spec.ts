import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectClaudeAvailability } from '@/utils/claude';

/**
 * Claude の導入・ログイン検出。`--version` の可否は実 `claude` に依存するので、
 * **未導入の経路**（存在しないコマンド）と、**ログインの判定材料**（env / 資格情報
 * ファイル）だけを固定する。keychain は読まない（＝ macOS OAuth は `'unknown'`）。
 */
describe('detectClaudeAvailability', () => {
  const MISSING = '/nonexistent/claude-binary-for-tests';

  it('reports not-installed when the binary is missing', async () => {
    const a = await detectClaudeAvailability({ command: MISSING });
    expect(a).toEqual({ installed: false, loggedIn: false });
  });

  // 導入確認は `<command> --version` の終了コードなので、必ず 0 で返る `node` を
  // command に差せば「導入済み」経路を実バイナリ無しで通せる（`node --version` = 0）。
  const OK = process.execPath;

  it('treats ANTHROPIC_API_KEY as logged in', async () => {
    const a = await detectClaudeAvailability({
      command: OK,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      home: '/nonexistent-home',
    });
    expect(a).toEqual({ installed: true, loggedIn: true });
  });

  it('treats Bedrock/Vertex env flags as logged in', async () => {
    const a = await detectClaudeAvailability({
      command: OK,
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      home: '/nonexistent-home',
    });
    expect(a.loggedIn).toBe(true);
  });

  it("returns 'unknown' when installed but no env and no credentials file (macOS keychain case)", async () => {
    const a = await detectClaudeAvailability({ command: OK, env: {}, home: '/nonexistent-home' });
    expect(a).toEqual({ installed: true, loggedIn: 'unknown' });
  });

  describe('with a credentials file on disk', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'codiva-claude-'));
      await mkdir(join(home, '.claude'), { recursive: true });
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('treats a non-empty ~/.claude/.credentials.json as logged in', async () => {
      await writeFile(join(home, '.claude', '.credentials.json'), '{"token":"x"}', 'utf8');
      const a = await detectClaudeAvailability({ command: OK, env: {}, home });
      expect(a).toEqual({ installed: true, loggedIn: true });
    });

    it("treats an empty credentials file as 'unknown' (not logged in via file)", async () => {
      await writeFile(join(home, '.claude', '.credentials.json'), '   \n', 'utf8');
      const a = await detectClaudeAvailability({ command: OK, env: {}, home });
      expect(a.loggedIn).toBe('unknown');
    });
  });
});
