import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  findCommand,
  isCommandInput,
  matchCommands,
  parseCommand,
  runCommand,
} from './commands';
import { messages } from './i18n';

describe('isCommandInput', () => {
  it.each([
    ['/help', true],
    ['/', true],
    ['/  spaced', true],
    ['help', false],
    ['', false],
    [' /help', false], // leading space is a normal instruction, not a command
  ] as const)('%s → %s', (value, expected) => {
    expect(isCommandInput(value)).toBe(expected);
  });
});

describe('parseCommand', () => {
  it('returns null for non-command input', () => {
    expect(parseCommand('build the thing')).toBeNull();
  });
  it.each([
    ['/help', { name: 'help', args: '' }],
    ['/EXIT', { name: 'exit', args: '' }], // name is lowercased
    ['/help me now', { name: 'help', args: 'me now' }],
    ['/help   trimmed  ', { name: 'help', args: 'trimmed' }],
    ['/', { name: '', args: '' }],
    ['/ leading', { name: '', args: 'leading' }],
  ] as const)('%s → %o', (value, expected) => {
    expect(parseCommand(value)).toEqual(expected);
  });
});

describe('findCommand', () => {
  it('resolves by canonical name', () => {
    expect(findCommand('exit')?.name).toBe('exit');
  });
  it('resolves by alias', () => {
    expect(findCommand('?')?.name).toBe('help');
  });
  it('no longer resolves the retired /quit alias', () => {
    expect(findCommand('quit')).toBeUndefined();
    expect(findCommand('q')).toBeUndefined();
  });
  it('returns undefined for unknown names', () => {
    expect(findCommand('nope')).toBeUndefined();
  });
});

describe('matchCommands', () => {
  it('returns [] for non-command input', () => {
    expect(matchCommands('hello')).toEqual([]);
  });
  it('lists all commands for a bare slash', () => {
    expect(matchCommands('/')).toEqual([...COMMANDS]);
  });
  it('prefix-matches the typed name', () => {
    expect(matchCommands('/ex').map((c) => c.name)).toEqual(['exit']);
    expect(matchCommands('/h').map((c) => c.name)).toEqual(['help']);
    expect(matchCommands('/mo').map((c) => c.name)).toEqual(['model']);
  });
  it('does not match the retired /quit alias', () => {
    expect(matchCommands('/q').map((c) => c.name)).toEqual([]);
  });
  it('returns [] when nothing matches', () => {
    expect(matchCommands('/zzz')).toEqual([]);
  });
});

describe('runCommand', () => {
  it('resolves a known command to a run result', () => {
    const result = runCommand('/exit');
    expect(result).toEqual({ kind: 'run', command: findCommand('exit') });
  });
  it('reports the retired /quit as unknown', () => {
    expect(runCommand('/quit')).toEqual({ kind: 'unknown', name: 'quit' });
  });
  it('resolves /model to the model command', () => {
    expect(runCommand('/model')).toEqual({ kind: 'run', command: findCommand('model') });
  });
  it('treats a bare slash as help (no false unknown)', () => {
    expect(runCommand('/')).toEqual({ kind: 'run', command: findCommand('help') });
  });
  it('reports unknown commands with the typed name', () => {
    expect(runCommand('/frobnicate')).toEqual({ kind: 'unknown', name: 'frobnicate' });
  });
  it('reports non-command input as unknown with empty name', () => {
    expect(runCommand('just text')).toEqual({ kind: 'unknown', name: '' });
  });
});

describe('command catalog', () => {
  it('every command has a localized description in both languages', () => {
    for (const command of COMMANDS) {
      expect(command.describe(messages.ja).length).toBeGreaterThan(0);
      expect(command.describe(messages.en).length).toBeGreaterThan(0);
    }
  });
  it('every action is unique per command name and names are unique', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
