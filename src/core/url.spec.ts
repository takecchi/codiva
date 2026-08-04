import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import {
  canHyperlink,
  detectUrls,
  isOpenableUrl,
  linkAt,
  linkPieces,
  linksInSlice,
  mergeLinks,
  openableUrl,
  osc8,
  spanLinks,
} from './url';

describe('detectUrls', () => {
  const cases: [name: string, text: string, expected: [number, number, string][]][] = [
    ['URL が無い行', 'no links here', []],
    ['裸の URL 1 本', 'see https://example.com/a for more', [[4, 25, 'https://example.com/a']]],
    [
      '2 本',
      'http://a.test/1 and https://b.test/2',
      [
        [0, 15, 'http://a.test/1'],
        [20, 36, 'https://b.test/2'],
      ],
    ],
    ['行頭・行全体', 'https://example.com', [[0, 19, 'https://example.com']]],
    [
      '文末のピリオドは URL に含めない',
      'go to https://example.com/x.',
      [[6, 27, 'https://example.com/x']],
    ],
    [
      '日本語の句点も削る',
      'ここ https://example.com/x を見て。',
      [[3, 24, 'https://example.com/x']],
    ],
    [
      '釣り合った括弧は URL の一部として残す',
      'https://ja.wikipedia.org/wiki/Foo_(bar)',
      [[0, 39, 'https://ja.wikipedia.org/wiki/Foo_(bar)']],
    ],
    ['釣り合わない閉じ括弧は削る', '(https://example.com/x)', [[1, 22, 'https://example.com/x']]],
    ['http/https 以外は拾わない', 'ftp://a.test/x mailto:a@b.test', []],
    ['スキームだけ・ホスト無しは拾わない', 'https:// and https://', []],
    [
      'ハイフンやクエリを含む URL を途中で切らない',
      'https://my-host.example.com/a-b?q=1&r=2#frag',
      [[0, 44, 'https://my-host.example.com/a-b?q=1&r=2#frag']],
    ],
    [
      '括弧書きの Markdown リンク末尾の ) は削る',
      'see [x](https://example.com/x)',
      [[8, 29, 'https://example.com/x']],
    ],
  ];

  it.each(cases)('%s', (_name, text, expected) => {
    expect(detectUrls(text)).toEqual(expected.map(([from, to, url]) => ({ from, to, url })));
  });

  it('検出した範囲は元テキストの URL とちょうど重なる', () => {
    const text = 'a https://example.com/p?q=1 b';
    const [link] = detectUrls(text);
    expect(link).toBeDefined();
    expect(text.slice(link?.from, link?.to)).toBe(link?.url);
  });
});

describe('isOpenableUrl / openableUrl', () => {
  it.each([
    ['https://a.test', true],
    ['http://a.test/x', true],
    ['ftp://a.test', false],
    ['mailto:a@b.test', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['https://', false],
    [`https://a.test/${'x'.repeat(1100)}`, false],
  ])('%s → %s', (url, expected) => {
    expect(isOpenableUrl(url)).toBe(expected);
  });

  it('制御文字を含む URL は開かない', () => {
    expect(isOpenableUrl(`https://a.test/${String.fromCharCode(27)}[0m`)).toBe(false);
  });

  it('openableUrl は絞り込みに使える', () => {
    expect(openableUrl('https://a.test')).toBe('https://a.test');
    expect(openableUrl('mailto:a@b.test')).toBeUndefined();
    expect(openableUrl(undefined)).toBeUndefined();
  });
});

describe('linkAt', () => {
  const links = [
    { from: 2, to: 5, url: 'https://a.test' },
    { from: 10, to: 12, url: 'https://b.test' },
  ];

  it.each([
    [0, undefined],
    [1, undefined],
    [2, 'https://a.test'],
    [4, 'https://a.test'],
    [5, undefined], // 排他の終端
    [10, 'https://b.test'],
    [12, undefined],
  ])('index %i → %s', (index, expected) => {
    expect(linkAt(links, index)).toBe(expected);
  });

  it('links なしは undefined', () => {
    expect(linkAt(undefined, 3)).toBeUndefined();
  });
});

describe('linksInSlice', () => {
  const links = [{ from: 5, to: 15, url: 'https://a.test/long' }];

  it('スライスに掛かる部分だけを、base 基準へ移して返す', () => {
    // 行 [0,10) の部分 → 行内 5..10、prefix 2 文字ぶんずらす
    expect(linksInSlice(links, 0, 10, 2)).toEqual([
      { from: 7, to: 12, url: 'https://a.test/long' },
    ]);
  });

  it('折り返しの後半にも URL 全体が残る（半分でも開ける）', () => {
    expect(linksInSlice(links, 10, 20, 0)).toEqual([
      { from: 0, to: 5, url: 'https://a.test/long' },
    ]);
  });

  it('掛からないスライスは空', () => {
    expect(linksInSlice(links, 20, 30)).toEqual([]);
  });
});

describe('mergeLinks', () => {
  it('重なる extra は捨て、重ならないものは足して文書順に並べる', () => {
    const primary = [{ from: 5, to: 10, url: 'https://href.test' }];
    const extra = [
      { from: 6, to: 9, url: 'https://bare.test' }, // 重なる → 捨てる
      { from: 0, to: 3, url: 'https://other.test' }, // 重ならない → 残る
    ];
    expect(mergeLinks(primary, extra)).toEqual([
      { from: 0, to: 3, url: 'https://other.test' },
      { from: 5, to: 10, url: 'https://href.test' },
    ]);
  });
});

describe('spanLinks', () => {
  it('スパンの link から行内の範囲を導く', () => {
    expect(
      spanLinks([{ text: 'ab' }, { text: 'cde', link: 'https://a.test' }, { text: 'f' }]),
    ).toEqual([{ from: 2, to: 5, url: 'https://a.test' }]);
  });

  it('隣り合う同じ URL のスパンは 1 本に繋ぐ', () => {
    expect(
      spanLinks([
        { text: 'ab', link: 'https://a.test' },
        { text: 'cd', link: 'https://a.test' },
      ]),
    ).toEqual([{ from: 0, to: 4, url: 'https://a.test' }]);
  });

  it('別 URL は分ける', () => {
    expect(
      spanLinks([
        { text: 'ab', link: 'https://a.test' },
        { text: 'cd', link: 'https://b.test' },
      ]),
    ).toEqual([
      { from: 0, to: 2, url: 'https://a.test' },
      { from: 2, to: 4, url: 'https://b.test' },
    ]);
  });

  it('空スパンは範囲を作らない', () => {
    expect(spanLinks([{ text: '', link: 'https://a.test' }])).toEqual([]);
  });
});

describe('linkPieces', () => {
  it('links が無ければセグメントそのまま', () => {
    expect(linkPieces(['ab', 'cd'])).toEqual([
      { text: 'ab', index: 0 },
      { text: 'cd', index: 1 },
    ]);
  });

  it('リンク境界でセグメントを切り、url を付ける', () => {
    const pieces = linkPieces(
      ['ab https://a.test cd'],
      [{ from: 3, to: 17, url: 'https://a.test' }],
    );
    expect(pieces).toEqual([
      { text: 'ab ', index: 0, url: undefined },
      { text: 'https://a.test', index: 0, url: 'https://a.test' },
      { text: ' cd', index: 0, url: undefined },
    ]);
  });

  it('セグメントを跨ぐリンクは各セグメントで切れる（スタイルを保つため）', () => {
    // spans = ['see ', 'my link'] で 4..11 が 1 本のリンク
    const pieces = linkPieces(['see ', 'my link'], [{ from: 4, to: 11, url: 'https://a.test' }]);
    expect(pieces).toEqual([
      { text: 'see ', index: 0, url: undefined },
      { text: 'my link', index: 1, url: 'https://a.test' },
    ]);
  });

  it('連結したテキストは元と一致する（文字を落とさない）', () => {
    const segments = ['ab ', 'https://a.test', ' cd https://b.test'];
    const links = [
      { from: 3, to: 17, url: 'https://a.test' },
      { from: 22, to: 36, url: 'https://b.test' },
    ];
    expect(
      linkPieces(segments, links)
        .map((p) => p.text)
        .join(''),
    ).toBe(segments.join(''));
  });

  it('リンクが 2 本連続していても進む（無限ループしない）', () => {
    const pieces = linkPieces(
      ['abcd'],
      [
        { from: 0, to: 2, url: 'https://a.test' },
        { from: 2, to: 4, url: 'https://b.test' },
      ],
    );
    expect(pieces).toEqual([
      { text: 'ab', index: 0, url: 'https://a.test' },
      { text: 'cd', index: 0, url: 'https://b.test' },
    ]);
  });
});

describe('osc8', () => {
  const ESC = String.fromCharCode(27);

  it('OSC 8 で包む（パラメータ無しの形）', () => {
    expect(osc8('https://a.test', 'click')).toBe(
      `${ESC}]8;;https://a.test${ESC}\\click${ESC}]8;;${ESC}\\`,
    );
  });

  it('端末が数える表示幅は包む前と同じ（レイアウトを狂わせない）', () => {
    // Ink の計測（string-width）と再構築（ansi-tokenize）は OSC 8 を幅 0 として扱う。
    // ここが崩れると当たり判定と描画がズレるので、幅で固定しておく。
    expect(stringWidth(osc8('https://a.test', 'click'))).toBe(stringWidth('click'));
    expect(stringWidth(osc8('https://a.test', '日本語'))).toBe(stringWidth('日本語'));
  });

  it('canHyperlink は開ける URL だけを通す', () => {
    expect(canHyperlink('https://a.test')).toBe(true);
    expect(canHyperlink('mailto:a@b.test')).toBe(false);
    expect(canHyperlink(undefined)).toBe(false);
  });
});
