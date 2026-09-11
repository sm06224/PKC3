/**
 * 🔴 **図案の書体**(#770 段①、2026-09-11)。
 *
 * ⚠ ここで守るのは 1 つだけ ── **豆腐(□)を出さない**。
 *   user の要望はそのものである:「**内部的にはリガチャで表示できないってことが
 *   ないようにしたい**」。
 *
 * 🔑 豆腐になる道は 3 本しかない。3 本とも門を置く:
 *   ① 表に足したのに**書体を焼き直していない**(glyph が無い)
 *   ② 表と書体の**符号位置が食い違う**(別の絵か、空白が出る)
 *   ③ CSS が**書体を当てていない**(既定の書体には私用領域の絵が無い)
 *
 * ⚠ ④「書体そのものが届かない」は**同梱**で消してある(外から取りに行かない)。
 *   実際に描けることは実ブラウザの smoke が見る ── ここは**配る物の突き合わせ**である。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { ICON_NAMES, PKC_SYMBOLS, symbolChar } from '../../src/features/icon/symbols';

const FONT = 'src/styles/fonts/pkc-symbols.woff2';
const LIST = 'src/styles/fonts/pkc-symbols.codepoints';

/** 焼いた書体の目録(`npm run icons:font` が書く)。 */
function baked(): Map<string, number> {
  return new Map(
    readFileSync(LIST, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name, hex] = l.split(' ');
        return [name!, parseInt(hex!, 16)] as const;
      }),
  );
}

describe('図案の書体(#770 段①)', () => {
  it('🔴 表に在る絵は、焼いた書体にも在る(足して焼き忘れると豆腐になる)', () => {
    const inFont = baked();
    // ⚠ 空振り防止 ── 目録が空なら下の for は 1 度も回らない
    expect(inFont.size, '焼いた書体の目録が空(前提が崩れている)').toBeGreaterThan(10);
    expect(ICON_NAMES.length, '図案の表が空(前提が崩れている)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      const { icon, cp } = PKC_SYMBOLS[name];
      expect(inFont.has(icon), `${name}(${icon})が書体に無い ── npm run icons:font を回す`).toBe(
        true,
      );
      expect(inFont.get(icon), `${name}(${icon})の符号位置が書体と食い違う`).toBe(cp);
    }
  });

  it('🔴 焼いた書体に、表から消えた絵が残っていない(要らない物を配らない)', () => {
    const want = new Set<string>(ICON_NAMES.map((n) => PKC_SYMBOLS[n].icon));
    for (const icon of baked().keys())
      expect(want.has(icon), `${icon} は表に無いのに焼かれている ── npm run icons:font を回す`).toBe(
        true,
      );
  });

  it('🔴 別の図案が同じ符号位置を指していない(取り違えが静かに通る)', () => {
    const seen = new Map<number, string>();
    for (const name of ICON_NAMES) {
      const cp = PKC_SYMBOLS[name].cp;
      const first = seen.get(cp);
      expect(first, `${name} と ${first ?? ''} が同じ絵になっている`).toBeUndefined();
      seen.set(cp, name);
    }
  });

  /**
   * ⚠ **私用領域であることを見る** ── 素の書体に在る字(`A` など)を割り当てると、
   *   書体が当たらなくても**それらしく出てしまう**ので、壊れたことに気づけない。
   */
  it('🔴 符号位置は私用領域(書体が無ければ豆腐になる = 気づける)', () => {
    for (const name of ICON_NAMES) {
      const cp = PKC_SYMBOLS[name].cp;
      expect(cp, `${name} の符号位置が私用領域の外`).toBeGreaterThanOrEqual(0xe000);
      expect(cp, `${name} の符号位置が私用領域の外`).toBeLessThanOrEqual(0xf8ff);
      // 描くのは **1 文字**(2 文字だと枠の幅が合わない)
      expect([...symbolChar(name)], `${name} が 1 文字になっていない`).toHaveLength(1);
    }
  });

  it('🔴 書体を同梱している(外から取りに行かない)', () => {
    const size = statSync(FONT).size;
    // ⚠ 下限も置く ── 0 バイトの file を置いても「在る」は真になる
    expect(size, '書体が小さすぎる(焼き損ない)').toBeGreaterThan(2000);
    // ⚠ 上限も置く ── 素の可変書体(5.37MB)を丸ごと置いてしまう手違いを止める
    expect(size, '書体が大きすぎる(部分集合になっていない)').toBeLessThan(200_000);
    /**
     * 🔴 **注釈を落としてから、`@font-face` の塊だけを見る**(2026-09-11。変異 MC が
     *   SURVIVED で教えた)。⚠ 1 稿目は **file 全体**を見ていたので、`block` を `swap` へ
     *   変えても**すぐ上に書いた自分の解説コメント**が条件を満たして緑だった
     *   (CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」の 6 度目)。
     */
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const face = /@font-face\s*\{([^}]*'PKC Symbols'[^}]*)\}/.exec(css)?.[1] ?? '';
    expect(face, '書体の宣言が読めていない(空振り)').not.toBe('');
    expect(face, 'CSS が書体を読み込んでいない').toContain("url('./fonts/pkc-symbols.woff2')");
    expect(face, '外から取りに行く形になっている').not.toContain('fonts.gstatic.com');
    // 🔑 届くまで**字を出さない**(`swap` だと私用領域の豆腐が一瞬出る)
    expect(face, 'font-display が block でない').toMatch(/font-display:\s*block/);
  });

  it('🔴 図案の枠に書体が当たっている(当たっていないと全部豆腐)', () => {
    const css = readFileSync('src/styles/app.css', 'utf8');
    const block = /\[data-pkc-icon\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block, '図案の枠の規則が読めていない(空振り)').not.toBe('');
    expect(block, '枠に書体が当たっていない').toContain("font-family: 'PKC Symbols'");
  });
});
