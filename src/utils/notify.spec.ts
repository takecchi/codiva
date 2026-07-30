import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn<() => NodeJS.Platform>());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:os', () => ({ platform: platformMock }));

const { buildNotifySequence, detectNotifyProtocol, notify, notifyCommand } = await import(
  '@/utils/notify'
);

const SPEC = { title: 'codiva: done', body: 'add login' };
const ESC = '\x1b';
const BEL = '\x07';

afterEach(() => {
  execFileMock.mockReset();
});

describe('detectNotifyProtocol', () => {
  it.each<[string, NodeJS.ProcessEnv, string | undefined]>([
    ['ghostty via TERM_PROGRAM', { TERM_PROGRAM: 'ghostty' }, 'osc777'],
    ['ghostty via TERM', { TERM: 'xterm-ghostty' }, 'osc777'],
    // tmux は TERM_PROGRAM を 'tmux' で上書きし TERM も screen-* に化ける。端末自前の
    // 変数で拾えないと tmux 内で通知が OS フォールバックに落ちてしまう。
    [
      'ghostty inside tmux (TERM_PROGRAM overwritten)',
      {
        TERM_PROGRAM: 'tmux',
        TERM: 'screen-256color',
        TMUX: '/tmp/tmux-501/default,1,0',
        GHOSTTY_BIN_DIR: '/Applications/Ghostty.app/Contents/MacOS',
      },
      'osc777',
    ],
    ['wezterm', { TERM_PROGRAM: 'WezTerm' }, 'osc777'],
    ['wezterm inside tmux', { TERM_PROGRAM: 'tmux', WEZTERM_PANE: '0' }, 'osc777'],
    ['foot', { TERM: 'foot-extra' }, 'osc777'],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, 'osc9'],
    // LC_TERMINAL は ssh が既定で転送するので、リモートの codiva からも手元へ届く。
    ['iTerm2 over ssh', { TERM: 'xterm-256color', LC_TERMINAL: 'iTerm2' }, 'osc9'],
    ['kitty via env', { KITTY_WINDOW_ID: '1' }, 'osc99'],
    ['kitty via TERM', { TERM: 'xterm-kitty' }, 'osc99'],
    // kitty は OSC 9 も解釈するが title を運べないので OSC 99 を優先する。
    ['kitty inside a wrapper', { KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'ghostty' }, 'osc99'],
    ['Apple Terminal (unsupported)', { TERM_PROGRAM: 'Apple_Terminal' }, undefined],
    ['bare xterm (unsupported)', { TERM: 'xterm-256color' }, undefined],
    // Windows Terminal の OSC 777 は allowOSC777 が既定 false、OSC 9 は数値サブコマンド
    // 専用。urxvt の OSC 777 は同梱されていない perl 拡張へ丸投げする口。どちらも
    // 「対応済み」と誤判定すると通知が無音で消えるので OS コマンドへ落とす。
    ['windows terminal (not detected on purpose)', { WT_SESSION: 'abc' }, undefined],
    ['urxvt (not detected on purpose)', { TERM: 'rxvt-unicode-256color' }, undefined],
    ['empty env', {}, undefined],
  ])('%s', (_label, env, expected) => {
    expect(detectNotifyProtocol(env)).toBe(expected);
  });
});

describe('buildNotifySequence', () => {
  it('builds an OSC 777 sequence carrying title and body', () => {
    expect(buildNotifySequence(SPEC, 'osc777')).toBe(
      `${ESC}]777;notify;codiva: done;add login${BEL}`,
    );
  });

  it("replaces ';' in the OSC 777 title so it cannot shift the body field", () => {
    const seq = buildNotifySequence({ title: 'a;b', body: 'c' }, 'osc777');
    expect(seq).toBe(`${ESC}]777;notify;a,b;c${BEL}`);
  });

  it('concatenates title and body for OSC 9 (single-field protocol)', () => {
    const seq = buildNotifySequence(SPEC, 'osc9');
    expect(seq).toBe(`${ESC}]9;codiva: done — add login${BEL}`);
  });

  it("strips ';' from the OSC 9 payload so it cannot become a numeric sub-command", () => {
    // `9;4;70` は iTerm2/ConEmu ではプログレスバー指示。通知本文が化けないこと。
    const seq = buildNotifySequence({ title: 'codiva', body: '4;70' }, 'osc9');
    expect(seq).toBe(`${ESC}]9;codiva — 4,70${BEL}`);
  });

  it('sends base64 title and body chunks for OSC 99 (kitty)', () => {
    const seq = buildNotifySequence(SPEC, 'osc99', { id: '42-7' });
    expect(seq).toContain(
      `${ESC}]99;i=42-7:d=0:p=title:e=1;${Buffer.from(SPEC.title, 'utf8').toString('base64')}${ESC}\\`,
    );
    expect(seq).toContain(
      `${ESC}]99;i=42-7:d=1:p=body:e=1;${Buffer.from(SPEC.body, 'utf8').toString('base64')}${ESC}\\`,
    );
  });

  it('strips control characters that would terminate the sequence early', () => {
    // ESC / BEL は空白へ潰され、title 側の ';' は ',' へ置換される。
    const seq = buildNotifySequence({ title: `a${ESC}]0;x${BEL}b`, body: 'c\nd' }, 'osc777');
    expect(seq).toBe(`${ESC}]777;notify;a ]0,x b;c d${BEL}`);
  });

  it('strips C1 control characters (UTF-8 ST / CSI) too', () => {
    const body = ['a', '\u009c', 'b', '\u009b', 'c'].join('');
    const seq = buildNotifySequence({ title: 't', body }, 'osc777');
    expect(seq).toBe(`${ESC}]777;notify;t;a b c${BEL}`);
  });

  it('truncates overlong text', () => {
    const seq = buildNotifySequence({ title: 't', body: 'x'.repeat(400) }, 'osc777');
    const body = seq.slice(seq.indexOf(';notify;t;') + ';notify;t;'.length, -1);
    expect(body).toHaveLength(120);
    expect(body.endsWith('…')).toBe(true);
  });

  it.each<'osc777' | 'osc9' | 'osc99'>(['osc777', 'osc9', 'osc99'])(
    'wraps %s for tmux passthrough with doubled ESC',
    (protocol) => {
      const seq = buildNotifySequence(SPEC, protocol, { tmux: true });
      expect(seq.startsWith(`${ESC}Ptmux;`)).toBe(true);
      expect(seq.endsWith(`${ESC}\\`)).toBe(true);
      expect(seq).toContain(`${ESC}${ESC}]`);
    },
  );
});

describe('notifyCommand', () => {
  it('builds an osascript command on darwin passing title/body as argv', () => {
    const cmd = notifyCommand(SPEC, 'darwin');
    expect(cmd?.file).toBe('osascript');
    // The literal strings must be the last two args (argv), not spliced into -e.
    expect(cmd?.args.slice(-2)).toEqual([SPEC.body, SPEC.title]);
    expect(cmd?.args.some((a) => a.includes(SPEC.title))).toBe(true);
  });

  it('builds a notify-send command on linux', () => {
    expect(notifyCommand(SPEC, 'linux')).toEqual({
      file: 'notify-send',
      args: [SPEC.title, SPEC.body],
    });
  });

  it.each<NodeJS.Platform>(['win32', 'aix', 'freebsd'])(
    'returns undefined on unsupported platform %s',
    (platform) => {
      expect(notifyCommand(SPEC, platform)).toBeUndefined();
    },
  );
});

describe('notify', () => {
  it('prefers the terminal escape sequence over the OS command on a known terminal', () => {
    const writes: string[] = [];
    notify(SPEC, {
      stream: { write: (t) => writes.push(t) },
      env: { TERM_PROGRAM: 'ghostty' },
      isTty: true,
      platform: 'darwin',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(']777;notify;');
    // osascript は使わない（Script Editor 名義の通知を避けるのが目的）。
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('varies the OSC 99 id between notifications so they do not overwrite each other', () => {
    const writes: string[] = [];
    const deps = {
      stream: { write: (t: string) => writes.push(t) },
      env: { KITTY_WINDOW_ID: '1' },
      isTty: true,
    };
    notify(SPEC, deps);
    notify(SPEC, deps);
    const idOf = (seq: string): string => seq.slice(seq.indexOf('i=') + 2, seq.indexOf(':d=0'));
    expect(idOf(writes[0] ?? '')).not.toBe(idOf(writes[1] ?? ''));
  });

  it('wraps the sequence for tmux passthrough when $TMUX is set', () => {
    const writes: string[] = [];
    notify(SPEC, {
      stream: { write: (t) => writes.push(t) },
      // tmux 内の実際の環境（TERM_PROGRAM は tmux に上書きされている）。
      env: {
        TERM_PROGRAM: 'tmux',
        TERM: 'screen-256color',
        TMUX: '/tmp/tmux-501/default,1,0',
        GHOSTTY_BIN_DIR: '/Applications/Ghostty.app/Contents/MacOS',
      },
      isTty: true,
      platform: 'darwin',
    });
    expect(writes[0]?.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('swallows a write failure on a destroyed stream', () => {
    expect(() =>
      notify(SPEC, {
        stream: {
          write: () => {
            throw new Error('ERR_STREAM_DESTROYED');
          },
        },
        env: { TERM_PROGRAM: 'ghostty' },
        isTty: true,
      }),
    ).not.toThrow();
  });

  it('falls back to the OS command on a terminal without OSC notifications', () => {
    const writes: string[] = [];
    notify(SPEC, {
      stream: { write: (t) => writes.push(t) },
      env: { TERM_PROGRAM: 'Apple_Terminal' },
      isTty: true,
      platform: 'darwin',
    });
    expect(writes).toEqual([]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('osascript');
  });

  it('does not write escape sequences when stdout is not a TTY', () => {
    const writes: string[] = [];
    notify(SPEC, {
      stream: { write: (t) => writes.push(t) },
      env: { TERM_PROGRAM: 'ghostty' },
      isTty: false,
      platform: 'linux',
    });
    expect(writes).toEqual([]);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('notify-send');
  });

  it('invokes execFile with the platform command (defaults read the process)', () => {
    platformMock.mockReturnValue('darwin');
    notify(SPEC, { env: {}, isTty: false });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('osascript');
  });

  it('does nothing on an unsupported platform', () => {
    platformMock.mockReturnValue('win32');
    notify(SPEC, { env: {}, isTty: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('swallows synchronous execFile errors', () => {
    platformMock.mockReturnValue('darwin');
    execFileMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    expect(() => notify(SPEC, { env: {}, isTty: false })).not.toThrow();
  });
});
