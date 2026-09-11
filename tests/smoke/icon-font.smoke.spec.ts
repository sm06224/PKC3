/**
 * 🔴 **図案が本当に描けている**(#770 段①、2026-09-11)。
 *
 * > user 要望 2026-09-07:「**内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * ⚠ unit(`tests/features/icon-symbols.test.ts`)が見られるのは**表と目録の突き合わせ**まで
 *   である ── woff2 は畳まれていて中身を読めないし、happy-dom は書体を持たない。
 * 🔑 **「豆腐(□)になっていない」は、実ブラウザでしか言えない。**
 *
 * ## 観測点 ── 「その書体で描いた幅」と「書体が無いときの幅」が違うこと
 *
 * ⚠ 「幅が 0 でない」では足りない ── 豆腐にも幅が在る。
 * 🔑 だから**対照群**を同じ測り方で採る:同じ符号位置を**素の書体**で測り、
 *   2 つが違うことを見る(= 私用領域の字が、こちらの書体から出ている)。
 * ⚠ そのうえで**送り幅が 1em**であることも見る ── Material の絵は 1em 送りなので、
 *   ここがばらけていたら「別の書体が拾われた」である。
 */
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors } from './helpers';

test('🔴 図案が 40 種とも書体から出ている(豆腐になっていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  const out = await page.evaluate(async () => {
    await document.fonts.ready;
    const FAMILY = '"PKC Symbols"';
    const loaded = document.fonts.check(`16px ${FAMILY}`);
    /**
     * ⚠ **画面に出ている図案から符号位置を拾う**(表を test に写さない ── §7)。
     *   器は `[data-pkc-icon]` で、中身は 1 文字である。
     */
    const chars = [
      ...new Set(
        [...document.querySelectorAll('[data-pkc-icon]')]
          .map((el) => el.textContent ?? '')
          .filter((t) => [...t].length === 1),
      ),
    ];
    const ctx = document.createElement('canvas').getContext('2d')!;
    const rows = chars.map((ch) => {
      ctx.font = `16px ${FAMILY}`;
      const withFont = ctx.measureText(ch).width;
      // 対照群 ── 同じ字を素の書体で
      ctx.font = '16px serif';
      const plain = ctx.measureText(ch).width;
      return { cp: ch.codePointAt(0) ?? 0, withFont, plain };
    });
    return { loaded, rows };
  });

  expect(out.loaded, '書体が読み込まれていない(全部豆腐になる)').toBe(true);
  // ⚠ 空振り防止 ── 画面に図案が並んでいること
  expect(out.rows.length, '画面に図案が 1 つも出ていない(台の空振り)').toBeGreaterThan(5);

  for (const r of out.rows) {
    const at = `U+${r.cp.toString(16).toUpperCase()}`;
    expect(r.withFont, `${at} の幅が 0(描かれていない)`).toBeGreaterThan(0);
    /**
     * 🔴 **1em 送り**である(Material の絵はすべて 1em)。
     * ⚠ ここがずれていたら、こちらの書体ではなく**別の書体が拾われている**。
     */
    expect(Math.abs(r.withFont - 16), `${at} の送り幅が 1em でない(${r.withFont}px)`).toBeLessThan(
      0.5,
    );
    expect(r.withFont, `${at} が素の書体と同じ幅(= 豆腐の可能性)`).not.toBeCloseTo(r.plain, 1);
  }

  expect(errors).toEqual([]);
});
