/**
 * 🔴 **折り返す帯の下地は地の色、区切りは各ボタンの輪**(#705 ② → #951)── CSS を構文で pin。
 *
 * ## なぜこの形なのか
 *
 * 旧い作りは `gap: 1px` + 下地 `--border` で線を作り、余りを `::after` で地の色に塗っていた。
 * ⚠ `::after` は**最後の段にしか居ない**ので、2 段以上に折れると上の段の余りが
 * **線色のベタ塗り**になる。
 *
 * ## 🔴 この test が 2 本しか見ていなかったせいで、4 本が 1 か月残った(#951)
 *
 * #705② の test は対象を **`detail-toolbar` と `format-bar` の 2 つに名指し**していた。
 * ⚠ だから残る 4 本は unit も smoke も **1 本も見ておらず**、user に
 * 「**操作ボタンの配置部分のグレー背景がずれて見える**」と報告されるまで気づけなかった。
 *
 * 🔑 だから**名指しをやめた** ── 「折り返す帯」を**構文で全数拾い**、
 * 新しく帯を足した人が**書き忘れても落ちる**形にする。
 *
 * ⚠ 実ブラウザの画素は別に測る(2026-09-16 実測: 新しい作り **0/72** /
 * 旧い作り `collection-bar` **72/72**・`create-bar` **72/72**・
 * `inspector-actions` 可視だった **36/36**。9 テーマ × 4 DPR × 2 幅)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

/**
 * 🔴 **下地に線色を使ってよい「折り返す器」の既知リスト**(等値で pin)。
 *
 * ⚠ **足すときは理由を 1 行書く。** ⚠ そして理由は「**余りが出ない**」でなければ
 *   ならない ── 「たぶん大丈夫」は理由ではない(#951 はそれで 4 本残した)。
 * 🔑 `KNOWN_DEAD` と同じ作法:直したら**ここから消さないと落ちる**ので、忘れられない。
 */
const ALLOWED_BORDER_BACKED: readonly (readonly [sel: string, why: string])[] = [
  [
    "[data-pkc-region='find-bar']",
    '並ぶのが入力欄と選び所なので button の輪が当たらない。余りは entry-filter が flex:1 で埋め切る',
  ],
];

/** `選択子 { 宣言 }` を全部読む。⚠ 選択子リストは `,` で割って**丸ごと一致**で見る。 */
function rules(text: string): { sels: string[]; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sels: (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' ')),
    body: m[2] ?? '',
  }));
}

/**
 * 🔑 **「折り返す帯」を構文で拾う** ── `display:flex` かつ `flex-wrap:wrap` かつ `gap:1px`。
 * ⚠ 名前(`*-bar`)では拾わない ── `inspector-actions` のように**帯と名乗らない帯**が在る。
 */
function wrappingBars(text: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  for (const r of rules(text)) {
    const flex = decl('display', 'flex').test(r.body);
    const wrap = decl('flex-wrap', 'wrap').test(r.body);
    const gap1 = decl('gap', '1px').test(r.body);
    if (flex && wrap && gap1) for (const sel of r.sels) out.push({ sel, body: r.body });
  }
  return out;
}

describe('折り返す帯の下地と区切り(#705 ② / #951)', () => {
  it('🔴 空振り防止 ── 折り返す帯が 6 本以上見つかる', () => {
    const bars = wrappingBars(css());
    // ⚠ 走査が壊れて 0 件になったら、下の全数検査は**何も見ずに緑**になる
    expect(bars.length, '折り返す帯の走査が壊れている(名前を変えた?)').toBeGreaterThanOrEqual(6);
  });

  it('🔴 折り返す帯の下地に線色を使わない ── 最後の段以外の余りがベタ塗りになる', () => {
    const allowed = new Set(ALLOWED_BORDER_BACKED.map(([s]) => s));
    const bad: string[] = [];
    for (const { sel, body } of wrappingBars(css())) {
      if (allowed.has(sel)) continue;
      if (decl('background', 'var\\(--border\\)').test(body)) bad.push(sel);
    }
    expect(bad, `下地が線色の帯が残っている(2 段以上に折れると余りが灰色になる): ${bad.join(' / ')}`).toEqual([]);
  });

  it('🔴 既知リストは等値 ── 直したのに残っていたら落ちる', () => {
    const text = css();
    for (const [sel] of ALLOWED_BORDER_BACKED) {
      const joined = blocksFor(text, sel).join('\n');
      expect(joined.length, `${sel} の規則が無い(既知リストが腐っている)`).toBeGreaterThan(0);
      expect(joined, `${sel} は既に直っている ── 既知リストから消すこと`).toMatch(
        decl('background', 'var\\(--border\\)'),
      );
    }
  });

  it('🔴 埋め草の `::after` を残さない ── 「最後の段だけ地の色」の名残', () => {
    const text = css();
    for (const { sel } of wrappingBars(text)) {
      const after = blocksFor(text, `${sel}::after`);
      const filler = after.filter((b) => /flex:\s*1 1 auto/.test(b) && decl('background', 'var\\(--surface\\)').test(b));
      expect(filler, `${sel}::after の埋め草が残っている(最後の段しか塗らない)`).toEqual([]);
    }
  });

  it('🔴 区切りは各ボタンの 1px の輪 ── 焦点の輪(:focus-visible)は殺さない', () => {
    const text = css();
    const ring = rules(text).find((r) =>
      r.sels.includes("[data-pkc-field='detail-toolbar'] button:not(:focus-visible)"),
    );
    expect(ring, '区切りの輪の規則が無い(ボタンがくっついて 1 枚に見える)').toBeDefined();
    expect(ring?.body ?? '', '輪が 1px の線色でない').toMatch(decl('outline', '1px solid var\\(--border\\)'));

    // 🔑 **下地を地の色にした帯は、全部この 1 つの規則に乗る**(片方だけ直る日を作らない)
    const allowed = new Set(ALLOWED_BORDER_BACKED.map(([s]) => s));
    const missing: string[] = [];
    for (const { sel } of wrappingBars(text)) {
      if (allowed.has(sel)) continue;
      if (!(ring?.sels ?? []).some((s) => s === `${sel} button:not(:focus-visible)`)) missing.push(sel);
    }
    expect(missing, `輪の規則に乗っていない帯がある(区切りが 1 本も出ない): ${missing.join(' / ')}`).toEqual([]);
  });

  it('⚠ 素の `button` に outline を書かない(共通の焦点の輪 2px を上書きする)', () => {
    const text = css();
    for (const { sel } of wrappingBars(text)) {
      expect(blocksFor(text, `${sel} button`).join('\n'), `${sel} button に outline が在る`).not.toMatch(
        decl('outline', '.*'),
      );
    }
  });
});
