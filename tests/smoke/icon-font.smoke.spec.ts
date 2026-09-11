/**
 * 🔴 **図案が本当に描けている**(#770 段①、2026-09-11)。
 *
 * > user 要望 2026-09-07:「**内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * 🔴 **ここが「配る書体」を見る唯一の場所である**(着地前レビュー 1)。
 *
 * ⚠ unit(`tests/features/icon-symbols.test.ts`)が比べているのは
 *   **表と、表から書いた目録**である ── `pkc-symbols.codepoints` は
 *   `scripts/build-icon-font.mjs` が `symbols.ts` から書いているので、
 *   **落としてきた woff2 は 1 バイトも読まれていない**(brotli で畳まれていて
 *   node から読めない)。実測:書体の cmap は **95 符号位置**在る(表は 40)。
 * 🔴 だから「**書体からだけ 1 つ消える**」(上流が絵を改名・退役させた日に起きる)は
 *   unit では原理的に捕まらない ── **ここで捕まえる**。
 *
 * ## 観測点 ── 3 つ。どれ 1 つでも欠けると嘘が通る
 *
 * ① 🔴 **目録の 40 件を「全部」測る**(画面に居る物だけではない)
 *    ⚠ 画面から拾う形だと、**そのとき出ていない絵**(`printer` = PDF 書き出し、
 *      `box` = 畳んである)が 1 度も測られない ── 消えても緑になる。
 * ② **送り幅が 1em**(Material の絵はすべて 1em)+ **素の書体と違う**
 *    ⚠ 「幅が 0 でない」では足りない ── 豆腐にも幅が在る。書体に**無い**符号位置は
 *      既定の書体へ落ちるので、この 2 つのどちらかが必ず崩れる。
 * ③ 🔴 **画面の器に、その書体が当たっている**(`getComputedStyle().fontFamily`)
 *    ⚠ ①② は canvas に `16px "PKC Symbols"` を**直に指定**して測るので、
 *      **`[data-pkc-icon]` が書体を使っていなくても値は変わらない** ──
 *      `app.css` から `font-family` を落とす変異が、①② だけでは生き延びる
 *      (CLAUDE.md §4「計器の名前が、計器の見ている範囲より広い」)。
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { gotoApp, collectPageErrors } from './helpers';

/**
 * 注文した目録(`npm run icons:font` が書く)を **node 側で**読む。
 * ⚠ 表を test に写さない(CLAUDE.md §7)── 同じ値を 3 か所目に置かない。
 */
const WANT = readFileSync('src/styles/fonts/pkc-symbols.codepoints', 'utf-8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => {
    const [icon, hex] = l.split(' ');
    return { icon: icon!, cp: parseInt(hex!, 16) };
  });

test('🔴 図案が目録の全数とも書体から出ている(豆腐になっていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ 空振り防止は **node 側**で先に ── 目録が空なら、以下は 1 件も測らずに緑になる
  expect(WANT.length, '注文の目録が空(前提が崩れている)').toBeGreaterThan(30);

  const out = await page.evaluate(async (want: readonly { icon: string; cp: number }[]) => {
    await document.fonts.ready;
    const FAMILY = '"PKC Symbols"';
    const loaded = document.fonts.check(`16px ${FAMILY}`);

    /**
     * 🔴 **画面の器に書体が当たっているか**(観測点③)。
     * ⚠ ここだけは**実物の要素**から採る ── canvas に family を直に指定する
     *   ①② は、器が書体を使っていなくても同じ値を返す。
     */
    const span = document.querySelector('[data-pkc-icon]');
    const family = span === null ? '' : getComputedStyle(span).fontFamily;

    /**
     * 🔴 **器に字が入っていない**(2026-09-11)── ここが崩れると、文言を読む側
     *   (`toHaveText` で比べる smoke が 4 本)が**見た目 1 ドットも変わらないまま**外れる。
     * ⚠ 起動を 1 つも足さずに済むので、この道中で見る(`scripts/smoke-budget.mjs`)。
     */
    const withText = [...document.querySelectorAll('[data-pkc-icon]')].filter(
      (el) => (el.textContent ?? '') !== '',
    ).length;

    const ctx = document.createElement('canvas').getContext('2d')!;
    const rows = want.map(({ icon, cp }) => {
      const ch = String.fromCodePoint(cp);
      ctx.font = `16px ${FAMILY}`;
      const withFont = ctx.measureText(ch).width;
      // 対照群 ── 同じ字を素の書体で(豆腐の幅はこちらに寄る)
      ctx.font = '16px serif';
      const plain = ctx.measureText(ch).width;
      return { icon, cp, withFont, plain };
    });
    return { loaded, rows, withText, family, sawSpan: span !== null };
  }, WANT);

  expect(out.loaded, '書体が読み込まれていない(全部豆腐になる)').toBe(true);
  expect(out.withText, '図案の器に字が入っている(ボタンの文言を読む側が静かに外れる)').toBe(0);

  // 🔴 観測点③ ── 画面の器が、その書体で描いている
  expect(out.sawSpan, '画面に図案の器が 1 つも無い(台の空振り)').toBe(true);
  expect(out.family, `器に書体が当たっていない(実際の font-family: ${out.family})`).toContain(
    'PKC Symbols',
  );

  // ⚠ 空振り防止 ── **注文した数だけ**測れている(画面に居た分ではない)
  expect(out.rows.length, '目録の全数を測れていない').toBe(WANT.length);

  for (const r of out.rows) {
    const at = `${r.icon}(U+${r.cp.toString(16).toUpperCase()})`;
    expect(r.withFont, `${at} の幅が 0(描かれていない)`).toBeGreaterThan(0);
    /**
     * 🔴 **1em 送り**である(Material の絵はすべて 1em)。
     * ⚠ ここがずれていたら、こちらの書体ではなく**別の書体が拾われている**
     *   ── つまり**その符号位置が書体に無い**(= 豆腐)。
     */
    expect(Math.abs(r.withFont - 16), `${at} の送り幅が 1em でない(${r.withFont}px)`).toBeLessThan(
      0.5,
    );
    expect(r.withFont, `${at} が素の書体と同じ幅(= 豆腐の可能性)`).not.toBeCloseTo(r.plain, 1);
  }

  expect(errors).toEqual([]);
});
