/**
 * 🔴 **図案の書体**(#770 段①、2026-09-11)。
 *
 * ⚠ ここで守るのは 1 つだけ ── **豆腐(□)を出さない**。
 *   user の要望はそのものである:「**内部的にはリガチャで表示できないってことが
 *   ないようにしたい**」。
 *
 * 🔴 **この file が見られるのは「注文書」までである**(着地前レビュー 1 で訂正)。
 *
 * ⚠ `pkc-symbols.codepoints` は **焼いた書体を読んで書いた物ではない** ──
 *   `scripts/build-icon-font.mjs` が `symbols.ts` の表から書いている
 *   (woff2 は brotli で畳まれていて node から読めないため)。
 *   実測:この書体の cmap は **95 符号位置**在る(表は 40)。
 * 🔴 だから **「書体からだけ 1 つ消える」は、この file では原理的に捕まえられない**。
 *   捕まえるのは実ブラウザの `tests/smoke/icon-font.smoke.spec.ts` で、
 *   **目録の 40 件を全部測る**(送り幅が 1em でなければ豆腐)。
 *
 * 🔑 ここが守る 3 つ(全部「注文が揃っているか」である):
 *   ① 表に足したのに **`npm run icons:font` を回し忘れた**(目録が古い)
 *   ② 表と目録の**符号位置が食い違う**
 *   ③ CSS が**枠に書体を当てていない**(既定の書体には私用領域の絵が無い)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { ICON_NAMES, PKC_SYMBOLS } from '../../src/features/icon/symbols';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

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
  it('🔴 表に在る絵は、注文した目録にも在る(足して焼き忘れると豆腐になる)', () => {
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

  /**
   * ⚠ **題名を直した**(2026-09-11)── かつては「**焼いた書体に**、表から消えた絵が
   *   残っていない(要らない物を配らない)」と書いてあったが、**配る書体については
   *   何も言っていない**(上の冒頭を見よ。実測で書体には 95 符号位置が入っている)。
   * 🔑 守れるのは「注文書が表より多くない」= **消したのに目録が古いまま**だけである。
   */
  it('🔴 注文した目録に、表から消えた絵が残っていない(消して回し忘れを捕まえる)', () => {
    const want = new Set<string>(ICON_NAMES.map((n) => PKC_SYMBOLS[n].icon));
    for (const icon of baked().keys())
      expect(want.has(icon), `${icon} は表に無いのに注文されている ── npm run icons:font を回す`).toBe(
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

  /**
   * 🔴 **構文で拾う**(2026-09-11、着地前レビュー 3)。
   *
   * ⚠ 1 稿目は `/\[data-pkc-icon\]\s*\{([^}]*)\}/` で**注釈も剥がずに**拾っていた。
   *   罠は 2 つ重なっていた:
   *   ① **注釈に満たされる** ── 規則から `font-family` を消しても、すぐ上の
   *      「🔴 **書体で描く** … ここを外すと**豆腐**になる」が条件を満たす
   *   ② 🔴 **子孫選択子に当たる** ── `[data-pkc-region='browse-tabs'] [data-pkc-icon]`
   *      も同じ形なので、**そちらへ書き足せば素の規則を空にしても緑**になる
   *      (実測:`app.css` にその形の規則が 2 本在る)。
   * 🔑 だから `tests/helpers/css-blocks.ts` で読む ── 選択子リストを `,` で割って
   *   **丸ごと一致**を見るので、子孫選択子は拾わない。
   */
  it('🔴 図案の枠に書体が当たっている(当たっていないと全部豆腐)', () => {
    const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf8')));
    const blocks = blocksFor(css, '[data-pkc-icon]');
    // ⚠ 空振り防止 ── 素の `[data-pkc-icon]` の規則が 1 本も取れていない形で
    //   「当たっている」と言わない
    expect(blocks.length, '図案の枠の規則が読めていない(空振り)').toBe(1);
    expect(blocks[0], '枠に書体が当たっていない').toContain("font-family: 'PKC Symbols'");
  });
});

/**
 * 🔴 **絵を出しているのは CSS である**(2026-09-11。全量 smoke が 5 件落ちて、こう直した)。
 *
 * ⚠ 器(`[data-pkc-icon]`)に字を入れると、**ボタン丸ごとの `textContent` に
 *   目に見えない 1 文字が混ざる** ── 文言を読む側が静かに外れる
 *   (CLAUDE.md §10「器を替えても、読み取れる値を変えない」)。
 * 🔑 だから絵は `::before { content }` が出す。⚠ ここで**符号位置が 3 か所目**に
 *   出てくるので(表 / 焼いた目録 / この CSS)、CLAUDE.md §7 のとおり突き合わせる。
 *   ⚠ **両方向**で見る ── 「規則が無い絵」は豆腐、「表に無い規則」は
 *   `npm run icons:font` を回し忘れた側の腐りである。
 */
describe('図案の規則(自動生成の CSS)', () => {
  const GEN = 'src/styles/icons.generated.css';

  /** `[data-pkc-icon][data-pkc-symbol='X']::before { content: '\\eYYY'; }` を全部読む。 */
  function rules(): Map<string, number> {
    const css = readFileSync(GEN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return new Map(
      [
        ...css.matchAll(
          /\[data-pkc-icon\]\[data-pkc-symbol='([a-z0-9-]+)'\]::before\s*\{\s*content:\s*'\\([0-9a-f]+)';\s*\}/g,
        ),
      ].map((m) => [m[1] as string, parseInt(m[2] as string, 16)] as const),
    );
  }

  it('🔴 表に在る絵は、全部 CSS の規則を持つ(無い絵は何も描かれない)', () => {
    const got = rules();
    // ⚠ 空振り防止 ── 綴りが変わって 1 件も拾えていないと、下の for が回らない
    expect(got.size, '規則を 1 つも拾えていない(生成の形が変わった)').toBeGreaterThan(10);
    for (const name of ICON_NAMES) {
      expect(got.has(name), `${name} の規則が無い ── npm run icons:font を回す`).toBe(true);
      expect(got.get(name), `${name} の符号位置が CSS と食い違う`).toBe(PKC_SYMBOLS[name].cp);
    }
  });

  it('🔴 表から消えた絵の規則が残っていない(死んだ規則を溜めない)', () => {
    const want = new Set<string>(ICON_NAMES);
    for (const name of rules().keys())
      expect(want.has(name), `${name} は表に無いのに規則が在る ── npm run icons:font を回す`).toBe(
        true,
      );
  });

  it('🔴 その CSS が配られている(読み込まれなければ全部 空の器)', () => {
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, 'app.css が図案の規則を読み込んでいない').toContain(
      "@import './icons.generated.css';",
    );
  });
});
