/**
 * 🔴 **図案が本当に描けている**(#770 段①、2026-09-11 → **#1054 段①、2026-09-25 に
 * Phosphor Duotone へ**)。
 *
 * > user 要望 2026-09-07:「**内部的にはリガチャで表示できないってことがないようにしたい**」
 *
 * 🔴 **ここが「配る書体」を見る唯一の場所である**。
 *
 * ⚠ unit(`tests/features/icon-symbols.test.ts`)が比べているのは
 *   **表と、表から書いた目録**である ── `pkc-symbols.codepoints` は
 *   `scripts/build-icon-font.mjs` が**符号位置そのものを機械的に割り当てて**
 *   書いているので、**落としてきた woff2 は 1 バイトも読まれていない**
 *   (brotli で畳まれていて node から読めない)。
 * 🔴 だから「**書体からだけ 1 つ消える**」(remap の script が壊れた日に起きる)は
 *   unit では原理的に捕まらない ── **ここで捕まえる**。
 *
 * ## 🔴 1 稿目(Material Symbols 版)は「送り幅」で見ていた ── **豆腐に満たされていた**
 *
 * ⚠ 1 稿目の門は 2 つとも、**その書体の `.notdef`(豆腐)で満たされる**:
 *
 * | 測ったもの | 絵が在るとき | 🔴 **無いとき(豆腐)** |
 * |---|---|---|
 * | 送り幅 | 16.0px | **16.0px** ── `.notdef` の送り幅も **1.0em** |
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
 * ⚠ **これは「ブラウザが未定義の符号位置に出す最終手段の tofu」を測っている**
 *   のであって、**この書体自身の `.notdef` の中身とは別物**である(実測:
 *   Phosphor Duotone 自身の `.notdef` は輪郭を持たない空の glyph。fontTools で
 *   確認済み。それでもブラウザの最終手段には**必ず何か描かれる**ので測れる)。
 *
 * ## 🔴 Duotone は 1 絵につき符号位置が 2 つ(#1054 段①)
 *
 * ⚠ TOFU_CP は**焼いた目録が使う私用領域(0xE000 起点)と重ならない値**へ
 *   置く ── 重なると「対照群が実は本物の絵」という、前提が崩れた状態で
 *   全部が緑になる。
 *
 * ## 観測点は 4 つ。どれ 1 つでも欠けると嘘が通る
 *
 * ① 🔴 **目録の全件を「両方の符号位置(下地・線)とも」測る**(画面に居る物だけではない)
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
 * 🔴 **1 行に符号位置が 2 つ**(下地・線。#1054 段①)── 測るときは
 *   `{icon, part, cp}` へ展開して**両方とも**同じ扱いで見る。
 */
const WANT: readonly { icon: string; part: 'underlay' | 'line'; cp: number }[] =
  readFileSync('src/styles/fonts/pkc-symbols.codepoints', 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      const [icon, underlayHex, lineHex] = l.split(' ');
      return [
        { icon: icon!, part: 'underlay' as const, cp: parseInt(underlayHex!, 16) },
        { icon: icon!, part: 'line' as const, cp: parseInt(lineHex!, 16) },
      ];
    });

/**
 * 🔴 **対照群 ── この書体に必ず無い符号位置**(= 豆腐そのもの)。
 * ⚠ 焼いた目録は `0xE000` 起点で**私用領域の頭から詰める**ので、その範囲の
 *   外へ置く(#1054 段①。⚠ 直す前の Material 版は `0xE000` を使ったが、いまは
 *   その値そのものが実在の下地の符号位置なので使えない)。
 */
const TOFU_CP = 0xf000;

test('🔴 図案が目録の全数とも書体から出ている(豆腐になっていない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ⚠ 空振り防止は **node 側**で先に ── 目録が空なら、以下は 1 件も測らずに緑になる
  expect(WANT.length, '注文の目録が空(前提が崩れている)').toBeGreaterThan(60);
  // 🔴 **前提の assert** ── 対照群が目録に入っていたら、以下の比較は全部無意味になる
  expect(
    WANT.some((w) => w.cp === TOFU_CP),
    `対照群 U+${TOFU_CP.toString(16).toUpperCase()} が目録に在る(前提が崩れている)`,
  ).toBe(false);

  const out = await page.evaluate(
    async ({
      want,
      tofuCp,
    }: {
      want: readonly { icon: string; part: 'underlay' | 'line'; cp: number }[];
      tofuCp: number;
    }) => {
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
      const rows = want.map(({ icon, part, cp }) => ({
        icon,
        part,
        cp,
        width: measure(cp),
        ...sig(String.fromCodePoint(cp)),
      }));

      /**
       * 🔴 **M2・M7(#1054 段①-2、2026-09-25)── 色つきの図案が、実際に色を持って
       * 描かれているか**(この道中に相乗り。起動を 1 つも足さない ──
       * `scripts/smoke-budget.mjs`)。
       *
       * ⚠ unit(`tests/features/icon-symbols.test.ts`)は**生成 CSS の構造**
       *   (`content` が空でない)までしか見られない ── `opacity` や `color` が
       *   実際に**透明へ壊れていないか**(disabled と混同して 0 になる変異・
       *   tone の色が transparent になる変異)は、happy-dom が `::before` を
       *   計算しないので見えない。
       * ⚠ **`[data-pkc-icon][data-pkc-tone='…']` を直接組んだ probe で見る**
       *   (実在のボタンを探さない)── 「+ ノート」(create-run)は**主のボタン**
       *   (`data-pkc-primary`)で、色相を `--surface` と混ぜる規則が別に効くので、
       *   「線が tone 色になる」一般則の確認には使えない
       *   (実際に試して分かった ── アプリの特定のボタンに結び付けると、その面の
       *   都合(主のボタンかどうか)に左右される)。probe なら app.css の規則だけを
       *   純粋に見られる。
       */
      const toneProbe = document.createElement('span');
      toneProbe.setAttribute('data-pkc-icon', '');
      toneProbe.setAttribute('data-pkc-symbol', 'plus');
      toneProbe.setAttribute('data-pkc-tone', 'create');
      document.body.append(toneProbe);
      const neutralProbe = document.createElement('span');
      neutralProbe.setAttribute('data-pkc-icon', '');
      neutralProbe.setAttribute('data-pkc-symbol', 'close');
      neutralProbe.setAttribute('data-pkc-tone', 'neutral');
      document.body.append(neutralProbe);
      const toneBefore = getComputedStyle(toneProbe, '::before');
      const toneAfter = getComputedStyle(toneProbe, '::after');
      const neutralAfter = getComputedStyle(neutralProbe, '::after');
      const tone = {
        beforeContent: toneBefore.content,
        beforeOpacity: toneBefore.opacity,
        beforeColor: toneBefore.color,
        afterColor: toneAfter.color,
        neutralAfterColor: neutralAfter.color,
      };
      toneProbe.remove();
      neutralProbe.remove();

      /**
       * 🔴 **主のボタンでも、線に色が届いていて、反転した地の上で読める**
       * (#1054 段①-2 の着地前レビュー ──「+ ノート」の絵だけ色が 1px も見えない)。
       * ⚠ 実際に「+ ノート」(create-run。`markPrimary` 済み)で確かめる。
       * ⚠ 色は canvas で `rgb` へ解決する(`color-mix()` の計算値は `oklab(...)` の
       *   綴りで返ることがあり、文字列では比べられない)。
       */
      const primaryIcon = document.querySelector('[data-pkc-field="create-run"] [data-pkc-icon]');
      const colorCanvas = document.createElement('canvas');
      colorCanvas.width = colorCanvas.height = 1;
      const cx = colorCanvas.getContext('2d')!;
      const rgbOf = (c: string): number[] => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = '#000';
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const primary =
        primaryIcon === null
          ? null
          : {
              tone: primaryIcon.getAttribute('data-pkc-tone'),
              underlayOpacity: getComputedStyle(primaryIcon, '::before').opacity,
              line: rgbOf(getComputedStyle(primaryIcon, '::after').color),
              own: rgbOf(getComputedStyle(primaryIcon).color),
              ground: rgbOf(getComputedStyle(primaryIcon.closest('button')!).backgroundColor),
            };

      return { loaded, rows, withText, family, sawSpan: span !== null, tofu, plainW, tone, primary };
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
    const at = `${r.icon}/${r.part}(U+${r.cp.toString(16).toUpperCase()})`;
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
   * ⚠ **空振り防止** ── 全部同じ絵なら、測れていない(書体が 1 文字しか
   *   持っていない / 指紋が潰れている)。⚠ 意図的に同じ絵を指す名前が在る
   *   (`globe` と `launch-asset-raw` など)ので、等値ではなく下限で見る。
   *   🔴 **下限は WANT の件数から出す**(手で数を書かない ── 件数が動いた日に
   *   古い定数のまま緑になる、を防ぐ。CLAUDE.md「件数は書かない」)。
   */
  expect(
    new Set(out.rows.map((r) => r.hash)).size,
    '絵が 1 種類しか出ていない(指紋が潰れている?)',
  ).toBeGreaterThan(Math.floor(WANT.length * 0.5));

  // ⚠ 素の書体とは違う(= こちらの書体が実際に使われている)
  expect(out.rows[0]!.width, '素の書体と同じ幅(書体が効いていない)').not.toBeCloseTo(
    out.plainW,
    1,
  );

  /**
   * 🔴 **M2・M7(#1054 段①-2、2026-09-25)── 色つきの図案が、実際に色を持って
   * 描かれているか**(上の `page.evaluate` の `tone` / `primary` を見る)。
   */
  // 観測点(M2)── 下地の content が空でない(消えていない)
  expect(out.tone.beforeContent, '下地の content が none(規則が消えている)').not.toBe('none');
  expect(out.tone.beforeContent, '下地の content が空文字(規則が消えている)').not.toBe('""');

  // 観測点(M2)── 不透明度が 0 でない(disabled の減光と取り違えていない)
  const toneOpacity = Number(out.tone.beforeOpacity);
  expect(toneOpacity, '下地の不透明度が数値で読めない').not.toBeNaN();
  expect(toneOpacity, '下地の不透明度が 0(消えている)').toBeGreaterThan(0);
  expect(toneOpacity, '下地の不透明度が 1(tone の薄さが失われている)').toBeLessThan(1);

  /**
   * 観測点(M7)── 色が透明(alpha 0)になっていない。
   * ⚠ `rgb(...)`(alpha 省略)は解析できたら常に不透明として扱う ── 3 値のときは
   *   ブラウザが `rgb()` を返す(4 値のときだけ `rgba()`)。
   */
  const alphaOf = (color: string): number => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (m === null) return 1;
    const parts = (m[1] as string).split(',').map((s) => Number(s.trim()));
    return parts.length === 4 ? (parts[3] as number) : 1;
  };
  expect(alphaOf(out.tone.beforeColor), `下地の色が透明: ${out.tone.beforeColor}`).toBeGreaterThan(
    0,
  );
  expect(alphaOf(out.tone.afterColor), `線の色が透明: ${out.tone.afterColor}`).toBeGreaterThan(0);

  /**
   * ⚠ 線(::after)は tone='create' の色(緑系)であって、tone='neutral' の線
   *   (無彩色 `currentColor`)とは**違う**ことを見る(2026-09-25 の主眼
   *   「色をはっきり見せる」の直接の pin)。⚠ 2 つの probe を**同じ document**で
   *   比べるので、テーマ・地の色に依らず成り立つ。
   */
  expect(
    out.tone.afterColor,
    `create の線が neutral の線と同じ(tone が線に届いていない): create=${out.tone.afterColor} neutral=${out.tone.neutralAfterColor}`,
  ).not.toBe(out.tone.neutralAfterColor);

  /**
   * 🔴 **主のボタンでも、線に色が届いていて、反転した地の上で読める**(#1054 段①-2 の
   * 着地前レビュー)── 「+ ノート」(create-run。`markPrimary` 済み)で見る。
   * ⚠ 1 稿目は線を `currentColor`(反転した字の色)へ差し戻していた ── 書類の絵は
   *   下地が角の三角にしか無いので、**色がほぼ見えなかった**。
   * 🔑 2 つを対で見る:①線が字の色と**違う**(色相が届いている)
   *   ②線が反転した地に対して **3:1 以上**(一般の tone と同じ契約。溶けていない)。
   *   ⚠ ②だけでは `currentColor` の版も通る(字の色は地に対して十分濃い)ので①が要る。
   */
  expect(out.primary, '「+ ノート」の図案が見つからない(台の空振り)').not.toBeNull();
  expect(out.primary!.tone, '「+ ノート」の tone が create ではない(前提が崩れている)').toBe(
    'create',
  );
  expect(
    out.primary!.line,
    `主のボタンで線が字の色のまま(色が届いていない): line=${out.primary!.line}`,
  ).not.toEqual(out.primary!.own);
  const lum = (c: number[]): number => {
    const f = (v: number): number => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const [hi, lo] = [lum(out.primary!.line), lum(out.primary!.ground)].sort((a, b) => b - a);
  const contrast = (hi! + 0.05) / (lo! + 0.05);
  expect(
    contrast,
    `主のボタンで線が反転した地に溶けている: line=${out.primary!.line} ground=${out.primary!.ground} ratio=${contrast.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(3);
  // 下地は「濃く見せる」ので、一般の 0.32 より高い
  expect(
    Number(out.primary!.underlayOpacity),
    '主のボタンで下地が一般と同じ薄さのまま',
  ).toBeGreaterThan(0.32);

  expect(errors).toEqual([]);
});
