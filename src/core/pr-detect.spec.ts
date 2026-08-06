import { describe, expect, it } from 'vitest';
import {
  addPrRefs,
  allPrs,
  extractPrRefs,
  hasMultiplePrs,
  isPrCreateTool,
  MAX_SESSION_PRS,
  otherPrs,
  prCount,
  primaryPr,
  withoutPrRef,
} from './pr-detect';
import type { PrRef } from './types';

const ref = (number: number): PrRef => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
});

describe('isPrCreateTool', () => {
  const cases: [string, string, Record<string, unknown>, boolean][] = [
    ['plain gh pr create', 'Bash', { command: 'gh pr create --draft --fill' }, true],
    [
      'chained after push',
      'Bash',
      { command: 'git push -u origin x && gh pr create --fill' },
      true,
    ],
    ['extra spacing', 'Bash', { command: 'gh   pr\tcreate' }, true],
    ['gh pr view is not create', 'Bash', { command: 'gh pr view 12 --json url' }, false],
    ['gh pr list is not create', 'Bash', { command: 'gh pr list --state all' }, false],
    ['unrelated command', 'Bash', { command: 'npm test' }, false],
    ['missing command', 'Bash', {}, false],
    ['other tool with pr text', 'Read', { file_path: 'gh pr create.md' }, false],
    ['mcp create_pull_request', 'mcp__github__create_pull_request', {}, true],
    ['mcp unrelated', 'mcp__github__list_pull_requests', {}, false],
  ];
  it.each(cases)('%s', (_name, tool, input, expected) => {
    expect(isPrCreateTool(tool, input)).toBe(expected);
  });
});

describe('extractPrRefs', () => {
  it('reads the URL gh pr create prints', () => {
    const out = extractPrRefs(
      'Creating pull request for codiva/foo into main in acme/app\n\nhttps://github.com/acme/app/pull/95\n',
    );
    expect(out).toEqual([{ number: 95, url: 'https://github.com/acme/app/pull/95' }]);
  });

  const cases: [string, string, PrRef[]][] = [
    ['no url', 'nothing here', []],
    [
      'enterprise host with port',
      'https://git.corp.example:8443/team/repo/pull/7',
      [{ number: 7, url: 'https://git.corp.example:8443/team/repo/pull/7' }],
    ],
    [
      'trailing subpath is dropped',
      'see https://github.com/acme/app/pull/12/files for the diff',
      [{ number: 12, url: 'https://github.com/acme/app/pull/12' }],
    ],
    [
      'duplicate urls collapse',
      'https://github.com/acme/app/pull/3 and https://github.com/acme/app/pull/3',
      [{ number: 3, url: 'https://github.com/acme/app/pull/3' }],
    ],
    [
      'two different prs keep order',
      '{"html_url":"https://github.com/acme/app/pull/9"}\nhttps://github.com/acme/app/pull/4',
      [
        { number: 9, url: 'https://github.com/acme/app/pull/9' },
        { number: 4, url: 'https://github.com/acme/app/pull/4' },
      ],
    ],
    ['issue links are not prs', 'https://github.com/acme/app/issues/12', []],
  ];
  it.each(cases)('%s', (_name, text, expected) => {
    expect(extractPrRefs(text)).toEqual(expected);
  });

  it('is reusable (the shared regex resets its lastIndex)', () => {
    const text = 'https://github.com/acme/app/pull/1';
    expect(extractPrRefs(text)).toHaveLength(1);
    expect(extractPrRefs(text)).toHaveLength(1);
  });
});

describe('addPrRefs', () => {
  it('keeps the same array reference when nothing is new', () => {
    const existing = [ref(1)];
    expect(addPrRefs(existing, [])).toBe(existing);
    expect(addPrRefs(existing, [ref(1)])).toBe(existing);
    expect(addPrRefs(undefined, [])).toBeUndefined();
  });

  it('appends fresh refs in discovery order', () => {
    expect(addPrRefs([ref(1)], [ref(1), ref(2)])).toEqual([ref(1), ref(2)]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_SESSION_PRS + 5 }, (_, i) => ref(i + 1));
    expect(addPrRefs(undefined, many)).toHaveLength(MAX_SESSION_PRS);
  });
});

describe('primaryPr / otherPrs / prCount', () => {
  it('prefers the branch PR (the one codiva has a status glyph for)', () => {
    const state = { pr: ref(10), extraPrs: [ref(11), ref(12)] };
    expect(primaryPr(state)).toEqual(ref(10));
    expect(otherPrs(state)).toEqual([ref(11), ref(12)]);
    expect(prCount(state)).toBe(3);
    expect(allPrs(state)).toEqual([ref(10), ref(11), ref(12)]);
  });

  it('falls back to the newest self-created PR when the branch has none', () => {
    const state = { extraPrs: [ref(11), ref(12)] };
    expect(primaryPr(state)).toEqual(ref(12));
    expect(otherPrs(state)).toEqual([ref(11)]);
    expect(prCount(state)).toBe(2);
    expect(allPrs(state)).toEqual([ref(12), ref(11)]);
  });

  it('does not double-count the branch PR listed in extras', () => {
    const state = { pr: ref(10), extraPrs: [ref(10)] };
    expect(prCount(state)).toBe(1);
    expect(otherPrs(state)).toEqual([]);
  });

  it('is empty without any PR', () => {
    expect(primaryPr({})).toBeUndefined();
    expect(prCount({})).toBe(0);
    expect(allPrs({})).toEqual([]);
  });
});

describe('withoutPrRef', () => {
  it('removes the matching ref and returns undefined when nothing is left', () => {
    expect(withoutPrRef([ref(1)], ref(1))).toBeUndefined();
    expect(withoutPrRef([ref(1), ref(2)], ref(1))).toEqual([ref(2)]);
  });

  it('keeps the same reference when there is nothing to remove', () => {
    const existing = [ref(1)];
    expect(withoutPrRef(existing, ref(2))).toBe(existing);
    expect(withoutPrRef(existing, undefined)).toBe(existing);
    expect(withoutPrRef(undefined, ref(1))).toBeUndefined();
  });
});

describe('hasMultiplePrs', () => {
  const cases: [string, { pr?: PrRef; extraPrs?: PrRef[] }, boolean][] = [
    ['no pr at all', {}, false],
    ['branch pr only', { pr: ref(1) }, false],
    ['one self-created pr only', { extraPrs: [ref(2)] }, false],
    ['branch pr + one more', { pr: ref(1), extraPrs: [ref(2)] }, true],
    ['the same pr twice', { pr: ref(1), extraPrs: [ref(1)] }, false],
    ['two self-created prs', { extraPrs: [ref(2), ref(3)] }, true],
  ];
  it.each(cases)('%s', (_name, state, expected) => {
    expect(hasMultiplePrs(state)).toBe(expected);
  });
});
