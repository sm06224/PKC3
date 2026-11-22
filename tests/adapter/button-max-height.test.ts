/**
 * 🔴 **丈が伸びる規則は、共通の button の丈の上限を外す**(実機の崩れ。user 指示 2026-11-22)。
 *
 * 共通の `button` は `max-height: var(--row-h)` と `line-height: 1` を持つ(1 行のボタンの高さをそろえる)。
 * `height: auto` で丈を伸ばす規則がこの上限を外し忘れると、折り返した行の 3 行目から上端が切れ、下の項目にめり込む
 * (情報ペインの目次で実際に起きた)。
 * 🔑 全数で見る: コメントを剥がした `app.css` の規則のうち `height: auto` を持つ物は、`max-height` も書くこと。
 *   ボタンでない要素(入力欄・動画・表のセルなど)だけは既知の一覧に入れて外す(等値で固定 ── 増えたら見直す)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/app.css', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

/** `height: auto` を持つ規則(セレクタ → 本文)。 */
function autoHeightRules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2]!;
    if (/(^|[;\s])height:\s*auto\b/.test(body)) out.push({ selector: m[1]!.trim().replace(/\s+/g, ' '), body });
  }
  return out;
}

/** ボタンでない要素(共通の button の上限を受けない)── 等値で固定。 */
const NOT_BUTTONS = [
  'textarea',
  "[data-pkc-region='skip-links']:focus-within",
  '.pkc-md-rendered .pkc-asset-ref',
  '.pkc-md-rendered video.pkc-body-media',
  "[data-pkc-browse-pane='draw'] [data-pkc-field='image-draw-canvas']",
  "[data-pkc-slot='root'], [data-pkc-region='shell']",
  "[data-pkc-region='calendar-grid'] tbody td",
].sort();

describe('丈が伸びるボタンの規則', () => {
  it('🔴 `height: auto` を持つ規則は `max-height` も書く(ボタンでない既知の要素を除く)', () => {
    const rules = autoHeightRules();
    expect(rules.length, '空振り防止: 規則を拾えていない').toBeGreaterThan(10);
    const missing = rules.filter((r) => !/max-height\s*:/.test(r.body)).map((r) => r.selector);
    expect(missing.sort(), '丈を伸ばすのに上限を外していない規則がある(max-height: none を書く)').toEqual(NOT_BUTTONS);
  });

  it('🔴 情報ペインの目次・添付の行は、上限を外して行間を持つ', () => {
    const rule = autoHeightRules().find((r) => r.selector.startsWith("[data-pkc-field='inspector-toc-link']"));
    expect(rule?.body).toMatch(/max-height:\s*none/);
    expect(rule?.body).toMatch(/line-height:\s*1\.4/);
  });
});
