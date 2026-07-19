import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { messages } from '@/core';
import { Banner } from './banner';
import { MessagesProvider } from './i18n-context';

function renderBanner(props: Parameters<typeof Banner>[0], lang: 'ja' | 'en' = 'en') {
  return render(
    <MessagesProvider value={messages[lang]}>
      <Banner {...props} />
    </MessagesProvider>,
  );
}

describe('Banner', () => {
  it('設定されたモデル名をヘッダに表示する', () => {
    const { lastFrame } = renderBanner({ sessionCount: 0, model: 'claude-opus-4-8' }, 'en');
    expect(lastFrame()).toContain('model: claude-opus-4-8');
  });

  it('モデル未設定なら CLI 既定を表示する', () => {
    const { lastFrame } = renderBanner({ sessionCount: 0 }, 'en');
    expect(lastFrame()).toContain('model: CLI default');
  });

  it('モデル行は cwd 行の上に描画される', () => {
    const { lastFrame } = renderBanner(
      { sessionCount: 0, model: 'sonnet', cwd: '/tmp/repo' },
      'en',
    );
    const frame = lastFrame() ?? '';
    expect(frame.indexOf('model: sonnet')).toBeLessThan(frame.indexOf('/tmp/repo'));
  });
});
