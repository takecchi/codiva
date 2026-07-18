import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
const platformMock = vi.hoisted(() => vi.fn<() => NodeJS.Platform>());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('node:os', () => ({ platform: platformMock }));

const { notify, notifyCommand } = await import('@/utils/notify');

const SPEC = { title: 'codiva: done', body: 'add login' };

afterEach(() => {
  execFileMock.mockReset();
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
  it('invokes execFile with the platform command', () => {
    platformMock.mockReturnValue('darwin');
    notify(SPEC);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('osascript');
  });

  it('does nothing on an unsupported platform', () => {
    platformMock.mockReturnValue('win32');
    notify(SPEC);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('swallows synchronous execFile errors', () => {
    platformMock.mockReturnValue('darwin');
    execFileMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    expect(() => notify(SPEC)).not.toThrow();
  });
});
