import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from './commands';

describe('parseSlashCommand', () => {
  it.each([
    ['/model', 'model'],
    ['  /model  ', 'model'],
    ['/MODEL', 'model'],
  ] as const)('%s → %s', (input, expected) => {
    expect(parseSlashCommand(input)).toBe(expected);
  });

  it.each(['model', '/models', '/model page', 'implement /model', '', '/'])(
    'returns null for %s',
    (input) => {
      expect(parseSlashCommand(input)).toBeNull();
    },
  );
});
