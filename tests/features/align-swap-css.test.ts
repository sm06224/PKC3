/**
 * 🔴 **行頭アラインの入れ替え規則の意味論を CSS 面で pin する**
 * (user 裁定 2026-08-08、Issue #103:
 * 「**|> も<|も|<も意味は同じ、グローバルの文字の寄せを反対にする**」)。
 *
 * 実装は renderer に触れない ── `data-pkc-align="end"` 属性はそのまま
 * (goldens 不変)で、app.css の入れ替え規則が「宣言 align が flow start と
 * 逆の文書」のときだけ `end` / `start` の見え方を反転する。つまり**この意味論の
 * 実体は CSS の字面**であり、ここで等値 pin する(renderer 側の「属性は end の
 * まま」は `markdown-user-reports.test.ts`、両面 parity は
 * `markdown-css-parity.test.ts` が持つ)。
 *
 * ⚠ **存在だけでなく「全量」を等値で見る** ── 6 本のどれかが消えても、7 本目
 *   (例: center の入れ替え)が生えても落ちる。「center は入れ替えない
 *   (反対が定義できない)」という実装判断も、この等値がそのまま守る。
 * ⚠ 走査は `build/body-css.ts` の parser を使う ── 焼き込み(書き出し HTML)が
 *   規則を拾うのと**同じ読み方**で app.css を読む(判定を増やさない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRules } from '../../build/body-css';

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

  it('🔴 入れ替え規則は 6 本ちょうどで、値まで正しい(等値)', () => {
    expect(Object.fromEntries(swaps)).toEqual({
      // 横書き ltr(dir 無印 / ltr)で align: right ── 宣言 align が flow start と逆
      '.pkc-md-rendered[data-pkc-doc-align=right]:not([dir=rtl]) [data-pkc-align=end]':
        'text-align:start',
      '.pkc-md-rendered[data-pkc-doc-align=right]:not([dir=rtl]) [data-pkc-align=start]':
        'text-align:end',
      // 横書き rtl で align: left(rtl の flow start は右)
      '.pkc-md-rendered[data-pkc-doc-align=left][dir=rtl] [data-pkc-align=end]':
        'text-align:start',
      '.pkc-md-rendered[data-pkc-doc-align=left][dir=rtl] [data-pkc-align=start]':
        'text-align:end',
      // 縦書きで align: bottom(縦書きは direction: ltr 固定 = flow start は常に上)
      '.pkc-md-rendered[data-pkc-writing=vertical][data-pkc-doc-align=bottom] [data-pkc-align=end]':
        'text-align:start',
      '.pkc-md-rendered[data-pkc-writing=vertical][data-pkc-doc-align=bottom] [data-pkc-align=start]':
        'text-align:end',
    });
  });

  it('⚠ center の入れ替えは無い(「center の反対側」は定義できない ── end は end のまま)', () => {
    for (const sel of swaps.keys()) {
      expect(sel, 'center を入れ替える規則が生えた(裁定の外の拡張)').not.toContain(
        '[data-pkc-doc-align=center]',
      );
    }
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
      if (sel === '.pkc-md-rendered [data-pkc-align=end]'
        || sel === '.pkc-md-rendered [data-pkc-align=start]') {
        base.set(sel, normBody(r.body));
      }
    }
    expect(Object.fromEntries(base)).toEqual({
      '.pkc-md-rendered [data-pkc-align=end]': 'text-align:end',
      '.pkc-md-rendered [data-pkc-align=start]': 'text-align:start',
    });
  });
});
