/** @vitest-environment happy-dom */
/**
 * 🔴 **指で触る端末では、押し所を 24px より小さくしない**(#706 → #1029 段 A)。
 *
 * ## なぜ要るか
 *
 * 2026-09-05 に「触る端末だけ 24px を下限にする」と決めて 9 種類を直したが、
 * **その決まりを守らせる検査は 1 つも無かった** ── 次に誰かが
 * `@media (hover: none) and (pointer: coarse)` の中へ小さい寸法を書いても、
 * 何も鳴らない。24px は WCAG 2.2 の Target Size (Minimum) の値である。
 *
 * ⚠ **マウスの端末は見ない** ── そこを 24px へ広げるのは**見え方の変更**で、
 *   user の裁定が要る(一覧の 1 画面に入る行数が 3 割減る)。
 *   ここが見るのは「**指の端末のために作った例外の中**」だけである。
 *
 * ## ⚠ この検査を書くとき、1 稿目で踏んだ罠
 *
 * 🔴 `height` を素朴に探すと **`line-height` に当たる**(実際に
 * `.pkc-render-toggle` の `line-height: 22px` を「22px の押し所」と誤検出した)。
 * 🔑 だから**宣言の頭から**見る(`decl()` は `(?:^|;)` で留める)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mediaBlock, stripComments } from '../helpers/css-blocks';

const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
/** 🔴 WCAG 2.2 Target Size (Minimum)。⚠ 44px(AAA)にしない理由は #706 に在る。 */
const FLOOR_PX = 24;

/** `選択子 { 宣言 }` を全部読む(選択子リストは `,` で割る)。 */
function rules(text: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    for (const sel of (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' ')))
      out.push({ sel, body: m[2] ?? '' });
  return out;
}

describe('指の端末の押し所は 24px 以上(#706)', () => {
  const touch = (): string =>
    mediaBlock(stripComments(readFileSync('src/styles/app.css', 'utf-8')), TOUCH_QUERY).body;

  it('🔴 空振り防止 ── 指の端末の節が読めていて、規則が 10 本以上ある', () => {
    const list = rules(touch());
    expect(list.length, '指の端末の節が読めていない(問い合わせの字が変わった?)').toBeGreaterThan(
      10,
    );
  });

  it('🔴 指の端末の節に、24px を下回る寸法を書かない', () => {
    const bad: string[] = [];
    for (const { sel, body } of rules(touch())) {
      // ⚠ **宣言の頭から**見る ── そうしないと `line-height` が `height` に当たる
      for (const m of body.matchAll(/(?:^|;)\s*(min-height|min-width|height|width)\s*:\s*(\d+)px/g))
        if (Number(m[2]) < FLOOR_PX) bad.push(`${sel} → ${m[1]}: ${m[2]}px`);
    }
    expect(
      bad,
      `指の端末で押し所が ${FLOOR_PX}px を下回る指定が在る(WCAG 2.2 Target Size Minimum): ${bad.join(' / ')}`,
    ).toEqual([]);
  });

  it('🔴 行の高さ(--row-h)は、指の端末で 24px 以上へ上げてある', () => {
    const body = touch();
    const m = /--row-h:\s*(\d+)px/.exec(body);
    expect(m, '指の端末で --row-h を上げる規則が消えた(素の 26px のままになる)').not.toBeNull();
    expect(Number(m?.[1] ?? 0), '--row-h が 24px を下回っている').toBeGreaterThanOrEqual(FLOOR_PX);
  });
});
