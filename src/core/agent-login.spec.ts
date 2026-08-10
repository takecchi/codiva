import { describe, expect, it } from 'vitest';
import {
  appendLoginLine,
  finishLogin,
  initialLoginState,
  type LoginState,
  MAX_LOGIN_LINES,
} from '@/core/agent-login';

function feed(lines: readonly string[]): LoginState {
  let s = initialLoginState();
  for (const l of lines) {
    s = appendLoginLine(s, l);
  }
  return s;
}

describe('agent-login model', () => {
  it('starts running with no url/code and empty lines', () => {
    expect(initialLoginState()).toEqual({ status: 'running', lines: [] });
  });

  it('captures the first URL and keeps it fixed', () => {
    const s = feed([
      'Starting sign-in',
      'Open https://auth.example.com/device to continue',
      'or visit https://other.example.com/xyz', // 後続 URL では上書きしない
    ]);
    expect(s.url).toBe('https://auth.example.com/device');
  });

  it('captures a device code', () => {
    const s = feed(['Enter the code ABCD-1234 in your browser']);
    expect(s.code).toBe('ABCD-1234');
  });

  it('strips ANSI color codes before detecting the url and code', () => {
    // 実測: `codex login --device-auth` は URL / コードを青字（\x1b[94m…\x1b[0m）で出す。
    const esc = String.fromCharCode(27);
    const s = feed([
      `   ${esc}[94mhttps://auth.openai.com/codex/device${esc}[0m`,
      `   ${esc}[94mK9DJ-R4HNJ${esc}[0m`,
    ]);
    expect(s.url).toBe('https://auth.openai.com/codex/device');
    expect(s.code).toBe('K9DJ-R4HNJ');
    // 表示行にも生エスケープを残さない。
    expect(s.lines.some((l) => l.includes(esc))).toBe(false);
  });

  it('strips a trailing CR and keeps lines in order', () => {
    const s = feed(['one\r', 'two']);
    expect(s.lines).toEqual(['one', 'two']);
  });

  it('caps the retained lines', () => {
    const many = Array.from({ length: MAX_LOGIN_LINES + 10 }, (_, i) => `line ${i}`);
    const s = feed(many);
    expect(s.lines).toHaveLength(MAX_LOGIN_LINES);
    expect(s.lines.at(-1)).toBe(`line ${MAX_LOGIN_LINES + 9}`);
  });

  it('ignores non-openable url-ish text', () => {
    const s = feed(['run `codex login` again', 'no url here']);
    expect(s.url).toBeUndefined();
  });

  it('marks success on exit code 0', () => {
    const s = finishLogin(feed(['Open https://x/y']), 0);
    expect(s.status).toBe('succeeded');
    expect(s.error).toBeUndefined();
  });

  it('marks failure with the last non-empty line on a non-zero exit', () => {
    const s = finishLogin(feed(['trying…', 'error: could not reach server', '   ']), 1);
    expect(s.status).toBe('failed');
    expect(s.error).toBe('error: could not reach server');
  });

  it('falls back to the exit code when there is no output', () => {
    const s = finishLogin(initialLoginState(), 127);
    expect(s.status).toBe('failed');
    expect(s.error).toContain('127');
  });
});
