import { describe, expect, it } from 'vitest';
import { childEnv, type EnvRecord, NODE_ENV_INJECTED_VAR } from './child-env';

describe('childEnv', () => {
  const cases: { name: string; env: EnvRecord; expected: EnvRecord }[] = [
    {
      name: 'codiva が立てた NODE_ENV は落とす（npm が --omit=dev にならない）',
      env: { PATH: '/bin', NODE_ENV: 'production', [NODE_ENV_INJECTED_VAR]: '1' },
      expected: { PATH: '/bin' },
    },
    {
      name: 'ユーザーが渡した NODE_ENV はそのまま子へ',
      env: { NODE_ENV: 'development', [NODE_ENV_INJECTED_VAR]: '' },
      expected: { NODE_ENV: 'development' },
    },
    {
      name: 'マーカーが無い（シムを通らない起動）ときは何もしない',
      env: { NODE_ENV: 'production' },
      expected: { NODE_ENV: 'production' },
    },
    {
      name: 'マーカーは常に落とす（codiva の内部事情を子へ見せない）',
      env: { [NODE_ENV_INJECTED_VAR]: '1', FOO: 'bar' },
      expected: { FOO: 'bar' },
    },
    { name: '空の env', env: {}, expected: {} },
  ];

  for (const { name, env, expected } of cases) {
    it(name, () => {
      expect(childEnv(env)).toEqual(expected);
    });
  }

  it('引数を変更しない', () => {
    const env: EnvRecord = { NODE_ENV: 'production', [NODE_ENV_INJECTED_VAR]: '1' };
    childEnv(env);
    expect(env).toEqual({ NODE_ENV: 'production', [NODE_ENV_INJECTED_VAR]: '1' });
  });
});
