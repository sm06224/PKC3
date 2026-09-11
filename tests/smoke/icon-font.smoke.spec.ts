/**
 * 🔴 **図案が本当に描けている**(#770 段①、2026-09-11)。
 *
 * > user 要望 2026-09-07:「**内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * 🔴 **ここが「配る書体」を見る唯一の場所である**。
 *
 * ⚠ unit(`tests/features/icon-symbols.test.ts`)が比べているのは
 *   **表と、表から書いた目録**である ── `pkc-symbols.codepoints` は
 *   `scripts/build-icon-font.mjs` が `symbols.ts` から書いているので、
 *   **落としてきた woff2 は 1 バイトも読まれていない**(brotli で畳まれていて
 *   node から読めない)。実測:書体の cmap は **95 符号位置**在る(表は 40)。
 * 🔴 だから「**書体からだけ 1 つ消える**」(上流が絵を改名・退役させた日に起きる)は
 *   unit では原理的に捕まらない ── **ここで捕まえる**。
 *
 * ## 🔴 1 稿目は「送り幅」で見ていた ── **豆腐に満たされていた**
 *
 * ⚠ 1 稿目の門は 2 つとも、**この書体の `.notdef`(豆腐)で満たされる**:
 *
 * | 測ったもの | 絵が在るとき | 🔴 **無いとき(豆腐)** |
 * |---|---|---|
 * | 送り幅 | 16.0px | **16.0px** ── `.notdef` の送り幅も **1.0em**(fontTools 実測: 960/960) |
 * | 素の書体(serif)との差 | 違う | **違う**(豆腐 16.0 ≠ serif 12.4) |
 *
 * ⚠ だから `print` の符号位置を**書体に無い値**へ書き換えても **SURVIVED** だった
 *   ── 「PDF に書き出す」だけ豆腐で出荷される状態に、計器が 1 つも鳴らない。
 * 🔑 CLAUDE.md §1「**救い手が変わっただけ**」の書体版である ── 空振りを直したら
 *   「今度は何に救われていないか」を問う、が守れていなかった。
 *
 * ## 🔑 だから「豆腐そのもの」を対照群にする
 *
 * **この書体に必ず無い符号位置**を 1 つ選んで描き、**その絵と同じかどうか**を見る。
 * ⚠ 送り幅は在る/無いで 1 ビットも動かないので、比べるのは**画素**である
 * (64px で描いてアルファだけを畳んだ指紋 ── 実測で在る/無いがきれいに割れた)。
 * ⚠ 指紋の**値は pin しない**(環境で変わる)── 見るのは**同じ回の中での違い**だけ。
 *
 * ## 観測点は 4 つ。どれ 1 つでも欠けると嘘が通る
 *
 * ① 🔴 **目録の 40 件を「全部」測る**(画面に居る物だけではない)
 *    ⚠ 画面から拾う形だと、そのとき出ていない絵(`printer` = 詳細の帯、
 *      `box` = 畳んである)が 1 度も測られない。
 * ② 🔴 **豆腐と違う絵が出ている**(= その符号位置が書体に在る)
 * ③ **送り幅が 1em** ── ⚠ これは「在る」の証拠**ではない**(豆腐も 1em)。
 *    言えるのは「**別の書体が拾われていない**」だけなので、そう書いてある。
 * ④ 🔴 **画面の器に、その書体が当たっている**(`getComputedStyle().fontFamily`)
 *    ⚠ ①〜③ は canvas に `"PKC Symbols"` を**直に指定**して測るので、
 *      `[data-pkc-icon]` が書体を使っていなくても値は変わらない
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

/**
 * 🔴 **対照群 ── この書体に必ず無い符号位置**(= 豆腐そのもの)。
 * ⚠ 私用領域の頭。`Material Symbols` の絵はここから始まらない(実測で不在)。
 */
const TOFU_CP = 0xe000;

test('🔴 図案が目録の全数とも書体から出ている(豆腐になっていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ 空振り防止は **node 側**で先に ── 目録が空なら、以下は 1 件も測らずに緑になる
  expect(WANT.length, '注文の目録が空(前提が崩れている)').toBeGreaterThan(30);
  // 🔴 **前提の assert** ── 対照群が目録に入っていたら、以下の比較は全部無意味になる
  expect(
    WANT.some((w) => w.cp === TOFU_CP),
    `対照群 U+${TOFU_CP.toString(16).toUpperCase()} が目録に在る(前提が崩れている)`,
  ).toBe(false);

  const out = await page.evaluate(
    async ({ want, tofuCp }: { want: readonly { icon: string; cp: number }[]; tofuCp: number }) => {
      await document.fonts.ready;
      const FAMILY = '"PKC Symbols"';
      const loaded = document.fonts.check(`16px ${FAMILY}`);

      /**
       * 🔴 **画面の器に書体が当たっているか**(観測点④)。
       * ⚠ ここだけは**実物の要素**から採る ── canvas に family を直に指定する
       *   ①〜③ は、器が書体を使っていなくても同じ値を返す。
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

      /**
       * 🔑 **画素の指紋** ── 64px で描いて**アルファだけ**を畳む。
       * ⚠ 値そのものは環境で変わるので pin しない。使うのは**同じ回の中での比較**だけ。
       */
      const SIZE = 64;
      const cv = document.createElement('canvas');
      cv.width = SIZE;
      cv.height = SIZE;
      const g = cv.getContext('2d')!;
      const sig = (ch: string): { hash: number; ink: number } => {
        g.clearRect(0, 0, SIZE, SIZE);
        g.font = `48px ${FAMILY}`;
        g.textBaseline = 'top';
        g.fillStyle = '#000';
        g.fillText(ch, 4, 4);
        const px = g.getImageData(0, 0, SIZE, SIZE).data;
        let h = 0x811c9dc5;
        let ink = 0;
        for (let i = 3; i < px.length; i += 4) {
          const a = px[i]! > 8 ? 1 : 0;
          ink += a;
          h = ((h ^ a) * 0x01000193) >>> 0;
        }
        return { hash: h, ink };
      };

      const ctx = document.createElement('canvas').getContext('2d')!;
      const measure = (cp: number): number => {
        ctx.font = `16px ${FAMILY}`;
        return ctx.measureText(String.fromCodePoint(cp)).width;
      };
      ctx.font = '16px serif';
      const plainW = ctx.measureText(String.fromCodePoint(want[0]!.cp)).width;

      const tofu = sig(String.fromCodePoint(tofuCp));
      const rows = want.map(({ icon, cp }) => ({
        icon,
        cp,
        width: measure(cp),
        ...sig(String.fromCodePoint(cp)),
      }));
      return { loaded, rows, withText, family, sawSpan: span !== null, tofu, plainW };
    },
    { want: WANT, tofuCp: TOFU_CP },
  );

  expect(out.loaded, '書体が読み込まれていない(全部豆腐になる)').toBe(true);
  expect(out.withText, '図案の器に字が入っている(ボタンの文言を読む側が静かに外れる)').toBe(0);

  // 🔴 観測点④ ── 画面の器が、その書体で描いている
  expect(out.sawSpan, '画面に図案の器が 1 つも無い(台の空振り)').toBe(true);
  expect(out.family, `器に書体が当たっていない(実際の font-family: ${out.family})`).toContain(
    'PKC Symbols',
  );

  // ⚠ 空振り防止 ── **注文した数だけ**測れている(画面に居た分ではない)
  expect(out.rows.length, '目録の全数を測れていない').toBe(WANT.length);
  // ⚠ 対照群そのものが描けていない(= 指紋の仕掛けが動いていない)なら、以下は無意味
  expect(out.tofu.ink, '豆腐が 1 画素も描かれていない(指紋の仕掛けが動いていない)').toBeGreaterThan(
    0,
  );

  for (const r of out.rows) {
    const at = `${r.icon}(U+${r.cp.toString(16).toUpperCase()})`;
    /**
     * 🔴 **観測点② ── これが「書体に在る」の証拠である。**
     * ⚠ 送り幅では言えない(下を見よ)。豆腐と**違う絵**が出ていることだけが証拠。
     */
    expect(r.hash, `${at} が豆腐と同じ絵(その符号位置が書体に無い)`).not.toBe(out.tofu.hash);
    expect(r.ink, `${at} が 1 画素も描かれていない`).toBeGreaterThan(0);
    /**
     * 観測点③ ── 送り幅が 1em。
     * ⚠ **これは「絵が在る」の証拠ではない**(`.notdef` も 1em)。
     *   言えるのは「**別の書体が拾われていない**」だけである。
     */
    expect(Math.abs(r.width - 16), `${at} の送り幅が 1em でない(${r.width}px)`).toBeLessThan(0.5);
  }

  /**
   * ⚠ **空振り防止** ── 40 種が全部同じ絵なら、測れていない(書体が 1 文字しか
   *   持っていない / 指紋が潰れている)。⚠ 意図的に同じ絵を指す名前が在る
   *   (`globe` と `launch-asset-raw` など)ので、等値ではなく下限で見る。
   */
  expect(
    new Set(out.rows.map((r) => r.hash)).size,
    '絵が 1 種類しか出ていない(指紋が潰れている?)',
  ).toBeGreaterThan(30);

  // ⚠ 素の書体とは違う(= こちらの書体が実際に使われている)
  expect(out.rows[0]!.width, '素の書体と同じ幅(書体が効いていない)').not.toBeCloseTo(
    out.plainW,
    1,
  );

  expect(errors).toEqual([]);
});
