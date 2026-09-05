/**
 * 🔴 **押せないボタンは、見た目で押せないと分かる**(#715)。
 *
 * 直す前、`:disabled` の見た目の規則は**名指しの 4 か所**(glyph / order-nudge /
 * dual-head / dual-bookmark)にしか無く、情報ペインの操作の帯 12 個は
 * **編集中に `disabled` でも押せるボタンと同じ顔**だった ── しかも汎用の
 * `button:hover` に `:not(:disabled)` が無いので、乗せると色まで変わる。
 *
 * 🔑 だから**汎用**に置く。ここが見るのは 3 つ:
 *   ① `button:disabled` が在り、薄く(`opacity` < 1)・`cursor: not-allowed`
 *   ② 汎用の hover は disabled を**除く**(素の `button:hover` が残っていない)
 *   ③ 編集中の 1 行(`inspector-editing-note`)の規則が在る
 *
 * ⚠ happy-dom は描画しないので CSS は**構文で**読む(`css-blocks.ts`。選択子リストを
 *   `,` で割って丸ごと一致、`@media` の中は拾わない)。実ブラウザで**本当に薄いか**は
 *   `tests/smoke/layout.smoke.spec.ts`「編集中は … 押せない」が見る。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const CSS = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

describe('押せないボタンの見た目(#715)', () => {
  it('🔴 汎用の button:disabled が在り、薄く・cursor が not-allowed', () => {
    const blocks = blocksFor(CSS, 'button:disabled');
    expect(blocks.length, '汎用の button:disabled が無い').toBeGreaterThan(0);
    const joined = blocks.join(';');
    // ⚠ 宣言の先頭に固定して読む(`opacity` は他の規則にも在るので、部分一致にしない)
    const op = joined.match(decl('opacity', '([0-9.]+)'));
    expect(op, 'opacity を宣言していない').not.toBeNull();
    const value = Number(op![1]);
    expect(value, `薄くなっていない(opacity ${value})`).toBeLessThan(1);
    // ⚠ 下限も置く ── 0 にすると「消えた」と同じで、場所が動いたように見える
    expect(value, `見えなくなる(opacity ${value})`).toBeGreaterThan(0);
    expect(decl('cursor', 'not-allowed').test(joined), 'cursor が not-allowed でない').toBe(true);
  });

  it('🔴 汎用の hover は disabled を除く(乗せても色が変わらない)', () => {
    // ⚠ 丸ごと一致で見る ── `button:hover:not(:disabled)` は別の選択子として数える
    expect(
      blocksFor(CSS, 'button:hover'),
      '素の button:hover が残っている(disabled でも乗せると色が変わる)',
    ).toEqual([]);
    const hover = blocksFor(CSS, 'button:hover:not(:disabled)');
    expect(hover.length, '汎用の hover そのものが消えた').toBeGreaterThan(0);
    // 空振り防止 ── hover の規則が中身を持っている(選択子だけ残して宣言を消していない)
    expect(decl('background', 'var\\(--surface-2\\)').test(hover.join(';'))).toBe(true);
  });

  it('⚠ 汎用と同じ値の名指し(order-nudge)は畳んである ── 2 か所に同じ値を持たない', () => {
    expect(blocksFor(CSS, "[data-pkc-field='order-nudge'] button[disabled]")).toEqual([]);
    expect(blocksFor(CSS, "[data-pkc-field='order-nudge'] button:disabled")).toEqual([]);
  });

  it('🔴 編集中の 1 行は控えめな字で出る(規則が在る)', () => {
    const note = blocksFor(CSS, "[data-pkc-field='inspector-editing-note']");
    expect(note.length, '編集中の 1 行の規則が無い').toBeGreaterThan(0);
    expect(decl('color', 'var\\(--muted\\)').test(note.join(';')), '地の字の色になっていない').toBe(
      true,
    );
  });
});
