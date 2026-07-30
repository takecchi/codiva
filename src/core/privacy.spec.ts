import { describe, expect, it } from 'vitest';
import {
  GROVE_CACHE_MAX_AGE_MS,
  shouldWarnTraining,
  type TrainingOptIn,
  toTrainingOptIn,
  trainingOptInFromClaudeJson,
} from './privacy';

describe('toTrainingOptIn', () => {
  const cases: [string, unknown, TrainingOptIn][] = [
    ['enabled', { grove_enabled: true }, 'on'],
    ['disabled', { grove_enabled: false }, 'off'],
    ['null (ポリシーで選択不可なアカウント)', { grove_enabled: null }, 'unknown'],
    // domain_excluded の意味は未検証なので、対象外らしき応答では警告しない側に倒す。
    ['ON でも domain_excluded', { grove_enabled: true, domain_excluded: true }, 'unknown'],
    ['ON + domain_excluded が false', { grove_enabled: true, domain_excluded: false }, 'on'],
    ['ON + domain_excluded が null', { grove_enabled: true, domain_excluded: null }, 'on'],
    ['キー無し', { notice_is_grace_period: false }, 'unknown'],
    ['文字列の真似', { grove_enabled: 'true' }, 'unknown'],
    ['オブジェクトでない', 'nope', 'unknown'],
    ['null', null, 'unknown'],
    ['undefined', undefined, 'unknown'],
  ];

  it.each(cases)('%s → %s', (_label, json, expected) => {
    expect(toTrainingOptIn(json)).toBe(expected);
  });
});

describe('trainingOptInFromClaudeJson', () => {
  const now = 1_000_000_000;
  const uuid = 'acct-1';

  /** `accountUuid: null` は「oauthAccount が読めない（未ログイン等）」を表す。 */
  function claudeJson(entries: Record<string, unknown>, accountUuid: string | null = uuid) {
    return {
      oauthAccount: accountUuid === null ? undefined : { accountUuid },
      groveConfigCache: entries,
    };
  }

  const cases: [string, unknown, TrainingOptIn][] = [
    [
      'accountUuid のエントリ（ON）',
      claudeJson({ [uuid]: { grove_enabled: true, timestamp: now } }),
      'on',
    ],
    [
      'accountUuid のエントリ（OFF）',
      claudeJson({ [uuid]: { grove_enabled: false, timestamp: now - 1000 } }),
      'off',
    ],
    [
      'accountUuid 不明でもエントリが 1 件なら採用',
      claudeJson({ other: { grove_enabled: true, timestamp: now } }, null),
      'on',
    ],
    [
      // アカウント切替後: 前のアカウントの設定を今のアカウントのものとして流用しない。
      'accountUuid は分かっていてエントリが別アカウントだけ → 判定不能',
      claudeJson({ other: { grove_enabled: true, timestamp: now } }),
      'unknown',
    ],
    [
      'accountUuid 不一致でエントリが複数 → 判定不能',
      claudeJson({
        a: { grove_enabled: true, timestamp: now },
        b: { grove_enabled: false, timestamp: now },
      }),
      'unknown',
    ],
    [
      '期限切れ（7日超）は再取得へ回す',
      claudeJson({ [uuid]: { grove_enabled: true, timestamp: now - GROVE_CACHE_MAX_AGE_MS - 1 } }),
      'unknown',
    ],
    [
      '期限ちょうどは有効',
      claudeJson({ [uuid]: { grove_enabled: true, timestamp: now - GROVE_CACHE_MAX_AGE_MS } }),
      'on',
    ],
    ['timestamp が無い', claudeJson({ [uuid]: { grove_enabled: true } }), 'unknown'],
    [
      'timestamp が数値でない',
      claudeJson({ [uuid]: { grove_enabled: true, timestamp: 'x' } }),
      'unknown',
    ],
    ['エントリが空', claudeJson({}), 'unknown'],
    ['groveConfigCache が無い', { oauthAccount: { accountUuid: uuid } }, 'unknown'],
    ['オブジェクトでない', 42, 'unknown'],
  ];

  it.each(cases)('%s → %s', (_label, json, expected) => {
    expect(trainingOptInFromClaudeJson(json, now)).toBe(expected);
  });
});

describe('shouldWarnTraining', () => {
  const cases: [TrainingOptIn | undefined, boolean][] = [
    ['on', true],
    ['off', false],
    ['unknown', false],
    [undefined, false],
  ];

  it.each(cases)('%s → %s', (optIn, expected) => {
    expect(shouldWarnTraining(optIn)).toBe(expected);
  });
});
