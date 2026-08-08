/**
 * 🔴 **行頭アラインの入れ替え規則の意味論を CSS 面で pin する**
 * (user 裁定 2026-08-08、Issue #103:
 * 「**|> も<|も|<も意味は同じ、グローバルの文字の寄せを反対にする**」)。
 *
 * 象形的な形は専用の属性値 `data-pkc-align="opposite"` を出し(説明的な形からは
 * 書けない値)、app.css の入れ替え規則が「宣言 align が flow start と逆の文書」の
 * ときだけ `opposite` の見え方を反転する。つまり**この意味論の実体は CSS の字面**で
 * あり、ここで等値 pin する(renderer 側の「象形と説明で値が違う」は
 * `markdown-user-reports.test.ts`、両面 parity は `markdown-css-parity.test.ts`)。
 *
 * ⚠ **存在だけでなく「全量」を等値で見る** ── 4 本のどれかが消えても、5 本目
 *   (例: 説明的な形 `end` / `start` の入れ替え)が生えても落ちる。中央の
 *   「寄らない(inherit)」もこの等値がそのまま守る。
 * ⚠ 走査は `build/body-css.ts` の parser を使う ── 焼き込み(書き出し HTML)が
 *   規則を拾うのと**同じ読み方**で app.css を読む(判定を増やさない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractBodyCss, parseRules } from '../../build/body-css';

const CSS = readFileSync('src/styles/app.css', 'utf8');

/** 引用符を剥ぎ、空白を 1 個へ潰す(子孫結合子の空白は**残す**)。 */
const normSel = (s: string): string => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
/** 宣言側は空白と末尾 `;` を落として `text-align:start` の形へ。 */
const normBody = (s: string): string => s.replace(/\s+/g, '').replace(/;$/, '');

describe('行頭アラインの入れ替え規則(user 裁定 2026-08-08)', () => {
  // 「doc-align と(段落側の)align の両方を条件に持つ規則」= 入れ替え規則の全量。
  // ⚠ `[data-pkc-doc-align=` は `[data-pkc-align=` を部分文字列に**含まない**ので、
  //    この 2 条件で取り違えは起きない(`[` 込みで見るのが要点)
  const swaps = new Map<string, string>();
  for (const r of parseRules(CSS)) {
    if (r.at.length > 0) continue;
    const sel = normSel(r.selector);
    if (sel.includes('[data-pkc-doc-align=') && sel.includes('[data-pkc-align=')) {
      swaps.set(sel, normBody(r.body));
    }
  }

  it('🔴 入れ替え規則は 4 本ちょうどで、値まで正しい(等値)', () => {
    expect(Object.fromEntries(swaps)).toEqual({
      // 横書き ltr(dir 無印 / ltr)で align: right ── 宣言 align が flow start と逆
      '.pkc-md-rendered[data-pkc-doc-align=right]:not([dir=rtl]) [data-pkc-align=opposite]':
        'text-align:start',
      // 横書き rtl で align: left(rtl の flow start は右)
      '.pkc-md-rendered[data-pkc-doc-align=left][dir=rtl] [data-pkc-align=opposite]':
        'text-align:start',
      // 縦書きで align: bottom(縦書きは direction: ltr 固定 = flow start は常に上)
      '.pkc-md-rendered[data-pkc-writing=vertical][data-pkc-doc-align=bottom] [data-pkc-align=opposite]':
        'text-align:start',
      // 中央には反対側が無い ── 寄らない(= 何も変えない)
      '.pkc-md-rendered[data-pkc-doc-align=center] [data-pkc-align=opposite]': 'text-align:inherit',
    });
  });

  /**
   * 🔴 **説明的な形は入れ替えない**(user 指摘 2026-08-08)。
   * ⚠ **越境の理由をここに書き戻さないこと** ── かつて「`|>` の canonical な
   *   言い換えは `align=end` だから `end` も反転する」と書いてあった。それが
   *   「思想的な破壊的変更」と呼ばれたものである。
   * 象形的な形(矢印の絵)は向きを描き間違えても意図が通るので 4 形が同義になるが、
   * 言葉で書く説明的な形は `align=strat` を通せない = **寛容さが成立しない別の契約**。
   * 🔑 だから値ごと分けてある ── 入れ替えが当たるのは `opposite` だけである。
   */
  it('🔴 説明的な形(end / start)を入れ替える規則は 1 本も無い ── 境界を越えない', () => {
    for (const sel of swaps.keys()) {
      expect(sel, '説明的な形 start を入れ替える規則が戻ってきた').not.toContain(
        '[data-pkc-align=start]',
      );
      expect(sel, '説明的な形 end を入れ替える規則が戻ってきた(境界の踏み越え)').not.toContain(
        '[data-pkc-align=end]',
      );
    }
    // 空振り防止 ── 入れ替え規則そのものが消えていたら、この検査は何も守らない
    expect(swaps.size, '入れ替え規則が 1 本も無い(この検査が空振りしている)').toBe(4);
  });

  /**
   * 🔴 **中央の文書では寄らない**(user 指摘 2026-08-08:
   * 「文書のセンター寄せに反対もクソもないだろうが」)。
   * ⚠ 「反対が無いから流れの終わり側へ落とす」は**裁定が否定した旧実装への逆戻り**
   *   であり、規則を一文で言えなくする(「反対側へ。ただし中央のときだけ終わり側へ」)。
   *   だから値は `inherit` = **何も変えない**でなければならない。
   * ⚠ `center` と書くのも駄目 ── 入れ子で親が別の寄せを持つとき「中央へ寄せ直す」に
   *   なってしまう(「変わらない」とは違う)。
   */
  it('🔴 中央の文書では寄らない(値は inherit ── 終わり側へ落とさない)', () => {
    const center = [...swaps.entries()].filter(([sel]) =>
      sel.includes('[data-pkc-doc-align=center]'),
    );
    expect(center.length, '中央の文書で `|>` の行き先を決める規則が無い').toBe(1);
    expect(center[0]![1], '中央なのに寄せ直している(inherit = 何も変えない、が正)').toBe(
      'text-align:inherit',
    );
  });

  /**
   * ⚠ 入れ替え規則が**勝つ相手**(基底の logical 規則)が実在すること。
   * 基底が消えると、入れ替え対象の無い文書(align 宣言なし)で `end` が
   * ただの継承値になり、`|>` が**どこにも寄らなくなる** ── 入れ替え規則だけ
   * pin しても、この壊れ方は素通りする。
   */
  it('🔑 基底の end / start 規則が居る(入れ替えの土台)', () => {
    const base = new Map<string, string>();
    for (const r of parseRules(CSS)) {
      if (r.at.length > 0) continue;
      const sel = normSel(r.selector);
      if (sel === '.pkc-md-rendered [data-pkc-align=opposite]'
        || sel === '.pkc-md-rendered [data-pkc-align=end]'
        || sel === '.pkc-md-rendered [data-pkc-align=start]') {
        base.set(sel, normBody(r.body));
      }
    }
    expect(Object.fromEntries(base)).toEqual({
      '.pkc-md-rendered [data-pkc-align=opposite]': 'text-align:end',
      '.pkc-md-rendered [data-pkc-align=end]': 'text-align:end',
      '.pkc-md-rendered [data-pkc-align=start]': 'text-align:start',
    });
  });

  /**
   * 🔴 **文書全体の寄せ(doc-align)の基底規則も等値で pin する**
   * (2026-08-08 のレビューで実証。**1 巡目の修正が 2 巡目の対象**の実例)。
   *
   * `markdown-css-parity` は `[data-pkc-doc-align=left]` などの**字面が在るか**を
   * `toContain` で見ていた。ところが本 file が足した入れ替え規則は正規化後に
   * `…[data-pkc-doc-align=left][data-pkc-align=end]` という字面を持つので、
   * **入れ替え規則自身がその存在検査を満たしてしまう** ── 基底規則を消しても通る。
   *
   * とくに `left` は救い手がゼロだった(`align: left` を宣言する test が unit にも
   * smoke にも 1 件も無い)。消すと `direction: rtl` + `align: left` の文書で
   * 宣言が 100% no-op に戻り、**無印と `|>` が両方右**という辻褄の合わない画面になる。
   */
  it('🔴 文書全体の寄せの基底規則が全量そろっている(入れ替え規則が存在検査を満たす穴)', () => {
    const base = new Map<string, string>();
    for (const r of parseRules(CSS)) {
      if (r.at.length > 0) continue;
      const sel = normSel(r.selector);
      // doc-align を持ち、段落側の align を**持たない**もの = 基底
      if (sel.includes('[data-pkc-doc-align=') && !sel.includes('[data-pkc-align=')) {
        base.set(sel, normBody(r.body));
      }
    }
    expect(Object.fromEntries(base)).toEqual({
      '.pkc-md-rendered[data-pkc-doc-align=left]': 'text-align:left',
      '.pkc-md-rendered[data-pkc-doc-align=right]': 'text-align:right',
      '.pkc-md-rendered[data-pkc-doc-align=center]': 'text-align:center',
      '.pkc-md-rendered[data-pkc-writing=vertical][data-pkc-doc-align=top]': 'text-align:start',
      '.pkc-md-rendered[data-pkc-writing=vertical][data-pkc-doc-align=bottom]': 'text-align:end',
    });
  });

  /**
   * 🔴 **書き出し側でも同じ 9 本が立っている**(2026-08-08 の 2 巡目レビュー)。
   * ⚠ 上の 2 件は app.css だけを見ており、**焼き込み側は片肺**だった ──
   *   `markdown-css-parity` の VIEWER 側は `toContain('[data-pkc-doc-align=left]')`
   *   のままなので、入れ替え規則の字面で満たされて基底の欠落を見逃す。
   *   「片側を直したら対称の反対側を疑う」の、まさにその反対側である。
   * 🔑 焼き込みは app.css を素通しする設計なので、**両者が一致すること**を見れば
   *   「配った HTML でだけ寄せが違う」型の欠陥が 1 本の assert で止まる。
   */
  it('🔴 焼き込み(書き出し HTML)側にも同じ規則が同じ値で在る(片肺にしない)', () => {
    const baked = extractBodyCss(CSS, readFileSync('src/styles/tokens.css', 'utf8')).css;
    const got = new Map<string, string>();
    for (const r of parseRules(baked)) {
      if (r.at.length > 0) continue;
      const sel = normSel(r.selector);
      if (sel.includes('[data-pkc-doc-align=')) got.set(sel, normBody(r.body));
    }
    const want = new Map<string, string>();
    for (const r of parseRules(CSS)) {
      if (r.at.length > 0) continue;
      const sel = normSel(r.selector);
      if (sel.includes('[data-pkc-doc-align=')) want.set(sel, normBody(r.body));
    }
    // 空振り防止 ── 集められていないなら、この比較は何も守っていない
    expect(want.size, 'app.css 側で doc-align の規則を 1 本も拾えていない').toBe(9);
    expect(Object.fromEntries(got)).toEqual(Object.fromEntries(want));
  });
});
