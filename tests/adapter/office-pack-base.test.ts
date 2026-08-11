/** @vitest-environment happy-dom */
/**
 * O6-a: 配布元の URL の解き方(#88)。
 *
 * 🔴 **これは実際に踏んだ穴である**(2026-08-11)。既定を `'../office-pack/'` と
 * 相対で書いていたので、開いている場所の**深さ**で解決先が変わった:
 *
 * | 開いている場所 | `'../office-pack/'` | |
 * |---|---|---|
 * | `/PKC3/` | `/office-pack/` | ✓ |
 * | `/PKC3/dev/` | `/PKC3/office-pack/` | ✗ **404** |
 *
 * user が最初に開いたのは `/dev/` だったので、**押した瞬間に 404**。
 * ⚠ unit はこの関数を **1 度も通っていなかった** ── 「深さ」という次元が
 * fixture に無かった(CLAUDE.md「fixture のゼロ件の次元は測っていない次元」)。
 *
 * 🔑 だから **深さの違う出発点を並べて当てる**。1 つの baseURI だけで見ると、
 * また同じ形を見逃す。
 */
import { describe, expect, it } from 'vitest';
import { resolveBase } from '../../src/adapter/platform/office/office-pack-acquire';
import {
  DEFAULT_PACK_BASE,
  OfficePackError,
} from '../../src/adapter/platform/office/office-pack';

/** PKC3 が実際に配信されている / されうる場所。⚠ **深さがばらばら**であることが要点。 */
const WHERE = [
  ['リリース', 'https://sm06224.github.io/PKC3/'],
  ['dev(main の HEAD)', 'https://sm06224.github.io/PKC3/dev/'],
  ['origin 直下', 'https://example.test/'],
  ['もっと深い所', 'https://example.test/a/b/c/'],
  ['file 名まで入った baseURI', 'https://sm06224.github.io/PKC3/dev/index.html'],
] as const;

describe('既定の配布元の解決', () => {
  it.each(WHERE)('🔴 %s から開いても、origin 直下の /office-pack/ を指す', (_name, baseURI) => {
    const url = resolveBase(DEFAULT_PACK_BASE, baseURI);
    expect(url.href).toBe(`${new URL(baseURI).origin}/office-pack/`);
  });

  it('🔴 既定は深さに依存しない書き方である(相対に戻さない)', () => {
    // ⚠ ここが「実害の形」── `../` に戻すと、上の it.each が dev で落ちる
    expect(DEFAULT_PACK_BASE.startsWith('/'), '相対 path に戻っている').toBe(true);
    expect(DEFAULT_PACK_BASE).not.toContain('..');
  });

  it('末尾のスラッシュが無くても補う(file を続けて解けるように)', () => {
    expect(resolveBase('/office-pack', 'https://x.test/PKC3/').href)
      .toBe('https://x.test/office-pack/');
  });

  it('🔴 別 origin は弾く(CORS で必ず失敗する導線を作らない)', () => {
    expect(() => resolveBase('https://other.test/pack/', 'https://x.test/PKC3/'))
      .toThrow(OfficePackError);
  });

  it('同一 origin の別サブパスは通す(自分で置き場所を変えた人のため)', () => {
    expect(resolveBase('/my/pack/', 'https://x.test/PKC3/dev/').href)
      .toBe('https://x.test/my/pack/');
  });

  it('🔴 解いた先に pack.json を継ぎ足せる(1 段深くも浅くもならない)', () => {
    // ⚠ user が見た誤りは**この最終形**だった:
    //    https://sm06224.github.io/PKC3/office-pack/pack.json
    const url = new URL('pack.json', resolveBase(DEFAULT_PACK_BASE, WHERE[1][1]));
    expect(url.href).toBe('https://sm06224.github.io/office-pack/pack.json');
  });
});
