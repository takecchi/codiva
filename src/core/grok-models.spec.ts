import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GrokInitializeResult, GrokModelState } from '@/core/grok-events';
import { toGrokModelState } from '@/core/grok-events';
import { toGrokModelOptions } from '@/core/grok-models';
import { DEFAULT_MODEL_VALUE } from '@/core/models';

/**
 * `/model` の選択肢。モデル ID・表示名を直書きしないので、ここで確かめるのは
 * 「CLI が答えたカタログをそのまま行にできるか」だけ。実データは
 * `initialize` の `_meta.modelState`（`__fixtures__/grok-basic.jsonl` の 1 行目）。
 */
function fixtureModelState(): GrokModelState | undefined {
  const path = fileURLToPath(new URL('./__fixtures__/grok-basic.jsonl', import.meta.url));
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    const parsed = JSON.parse(line) as { id?: unknown; result?: GrokInitializeResult };
    if (parsed.id === 1) {
      return toGrokModelState(parsed.result?._meta?.modelState);
    }
  }
  throw new Error('grok-basic.jsonl carries no initialize response');
}

describe('toGrokModelOptions', () => {
  it('実データのカタログを、先頭に既定行を足した選択肢へ写す', () => {
    expect(toGrokModelOptions(fixtureModelState())).toEqual([
      // 番兵行（「CLI 既定を使う」）。設定へは undefined として書かれる。
      { value: DEFAULT_MODEL_VALUE, displayName: 'Default' },
      {
        value: 'grok-4.5',
        // Grok の modelId はエイリアスではなく実 ID なので突き合わせにそのまま使える。
        resolvedModel: 'grok-4.5',
        displayName: 'grok-4.5',
        description: undefined,
      },
      {
        value: 'grok-code-fast-2',
        resolvedModel: 'grok-code-fast-2',
        displayName: 'grok-code-fast-2',
        description: undefined,
      },
    ]);
  });

  it('既定行は必ず先頭で、value は番兵（resolvedModel を持たない）', () => {
    const [first] = toGrokModelOptions(fixtureModelState());
    expect(first?.value).toBe(DEFAULT_MODEL_VALUE);
    // 番兵を `resolvedModel` で突き合わせると、明示選択したモデルが「既定」行に
    // チェックされてしまう（`core/models.ts` の isCurrentModel と同じ約束）。
    expect(first?.resolvedModel).toBeUndefined();
  });

  it('説明文はそのまま通す（翻訳もしないし作りもしない）', () => {
    expect(
      toGrokModelOptions({
        currentModelId: 'grok-4.5',
        availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5', description: 'Flagship' }],
      }),
    ).toEqual([
      { value: DEFAULT_MODEL_VALUE, displayName: 'Default' },
      {
        value: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        displayName: 'Grok 4.5',
        description: 'Flagship',
      },
    ]);
  });

  it.each([
    ['name が無い', { modelId: 'grok-4.5' }, 'grok-4.5'],
    ['name が空白だけ', { modelId: 'grok-4.5', name: '   ' }, 'grok-4.5'],
    ['name がある', { modelId: 'grok-4.5', name: 'Grok 4.5' }, 'Grok 4.5'],
  ])('%s のとき displayName は %j', (_case, row, displayName) => {
    expect(toGrokModelOptions({ availableModels: [row] })[1]).toMatchObject({
      value: 'grok-4.5',
      displayName,
    });
  });

  it('modelId の無い行は落とす', () => {
    const options = toGrokModelOptions({
      availableModels: [{ name: 'nameless' }, { modelId: '   ' }, { modelId: 'grok-4.5' }],
    });
    expect(options.map((o) => o.value)).toEqual([DEFAULT_MODEL_VALUE, 'grok-4.5']);
  });

  it.each([
    ['undefined', undefined],
    ['availableModels が無い', { currentModelId: 'grok-4.5' }],
    ['availableModels が空', { availableModels: [] }],
    // 1 件も読めないときは既定行だけを出さず**空**を返す（呼び出し側がフォールバックする）。
    ['modelId の無い行だけ', { availableModels: [{ name: 'nameless' }] }],
  ] as [string, GrokModelState | undefined][])('%s なら空配列', (_case, state) => {
    expect(toGrokModelOptions(state)).toEqual([]);
  });

  it('壊れたカタログでも throw しない', () => {
    const garbage = { availableModels: [{ modelId: 7 }, { modelId: null }] };
    expect(toGrokModelOptions(garbage as unknown as GrokModelState)).toEqual([]);
  });
});
