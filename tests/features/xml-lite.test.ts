/** @vitest-environment node */
/**
 * 🔴 **worker には `DOMParser` が無い**(#238)。だから SVG は自前で読む。
 * ⚠ ここが静かに落とすと、図から**要素が消えるだけ**で例外は出ない ──
 * 「読めた件数」を数える形で守る。
 */
import { describe, expect, it } from 'vitest';
import { parseXml, textOf, walk, decodeEntities } from '../../src/features/export/xml-lite';

describe('parseXml', () => {
  it('入れ子・属性・自己閉じを読む', () => {
    const root = parseXml('<svg a="1"><g b=\'2\'><rect/><rect/></g></svg>');
    expect(root.tag).toBe('svg');
    expect(root.attrs['a']).toBe('1');
    const g = root.children[0]!;
    expect(g.attrs['b']).toBe('2');
    expect(g.children.filter((c) => c.tag === 'rect')).toHaveLength(2);
  });

  it('🔴 `<style>` の中は生のまま拾う(中の `>` を印と読まない)', () => {
    const root = parseXml('<svg><style>.a > .b{fill:#111;}</style><rect/></svg>');
    expect(textOf(root.children[0]!)).toContain('.a > .b');
    // ⚠ style の中身につられて木が壊れていないこと
    expect(root.children.some((c) => c.tag === 'rect')).toBe(true);
  });

  it('コメントと宣言を飛ばす', () => {
    const root = parseXml('<?xml version="1.0"?><!-- ね --><svg><!-- こ --><rect/></svg>');
    expect(root.tag).toBe('svg');
    expect(root.children.filter((c) => c.tag !== '#text')).toHaveLength(1);
  });

  it('CDATA を文字として拾う', () => {
    expect(textOf(parseXml('<svg><text><![CDATA[<まま>]]></text></svg>'))).toBe('<まま>');
  });

  it('🔴 実体参照を戻す(戻さないと `&amp;` が本文に出る)', () => {
    expect(decodeEntities('a&amp;b&lt;c&gt;d&#65;&#x42;')).toBe('a&b<c>dAB');
    // ⚠ 知らない実体は**そのまま残す**(落とすと本文が静かに欠ける)
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
  });

  it('属性値の中の `/` や `>` に釣られない(base64 が入る)', () => {
    const root = parseXml('<svg><path d="M0,0" data-points="W3si/eCI6MX0="></path></svg>');
    expect(root.children[0]!.attrs['data-points']).toBe('W3si/eCI6MX0=');
  });

  it('根が無ければ投げる(空を「読めた」と言わない)', () => {
    expect(() => parseXml('ただの字')).toThrow();
  });

  it('walk は鎖つきで全部返す', () => {
    const seen = [...walk(parseXml('<a><b><c/></b></a>'))].map((x) => x.chain.map((n) => n.tag).join('>'));
    expect(seen).toEqual(['a', 'a>b', 'a>b>c']);
  });
});
