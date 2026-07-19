import { describe, expect, it } from 'vitest';
import { openUrlCommand } from './open-url';

const URL = 'https://github.com/o/r/pull/7';

describe('openUrlCommand', () => {
  it('uses `open` on macOS', () => {
    expect(openUrlCommand(URL, 'darwin')).toEqual({ file: 'open', args: [URL] });
  });

  it('uses `xdg-open` on Linux', () => {
    expect(openUrlCommand(URL, 'linux')).toEqual({ file: 'xdg-open', args: [URL] });
  });

  it('uses `cmd /c start "" <url>` on Windows (url stays argv, not shell-spliced)', () => {
    expect(openUrlCommand(URL, 'win32')).toEqual({ file: 'cmd', args: ['/c', 'start', '', URL] });
  });

  it('returns undefined on unsupported platforms', () => {
    expect(openUrlCommand(URL, 'aix')).toBeUndefined();
  });
});
