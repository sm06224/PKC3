/**
 * 🔴 **折り返す帯は、線(輪)ではなく隙間で区切る**(#1982 段 2。旧い #705 ② / #951 の
 * 「各ボタンの外側 1px の輪を `gap: 1px` に重ねて 1 本線にする」作りを、背景の段差と余白へ移した)
 * ── CSS を構文で pin。
 *
 * ## なぜ見るのか
 *
 * - 旧い作りは画面を升目にしていた(#1982 §1 (a))。区切りは**ボタンの型(段 1)と隙間**で持つ。
 * - ⚠ #951 の教訓は生きている ── 名指しだけの検査は新しい帯が書き忘れても素通りするので、
 *   **「折り返す帯」を構文で全数拾い**、新しく帯を足した人が輪や線色の下地を書いたら落ちる形にする。
 *
 * ⚠ 見るのは**実行する規則**だけ(注釈は剥ぐ・`@media` の中は見ない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

/** `選択子 { 宣言 }` を全部読む。⚠ 選択子リストは `,` で割って**丸ごと一致**で見る。 */
function rules(text: string): { sels: string[]; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sels: (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' ')),
    body: m[2] ?? '',
  }));
}

/** 🔑 「折り返す帯」を構文で拾う ── `display:flex` かつ `flex-wrap:wrap`。名前(`*-bar`)では拾わない。 */
function wrappingBars(text: string): { sel: string; body: string }[] {
  const out: { sel: string; body: string }[] = [];
  for (const r of rules(text)) {
    if (decl('display', 'flex').test(r.body) && decl('flex-wrap', 'wrap').test(r.body)) {
      for (const sel of r.sels) out.push({ sel, body: r.body });
    }
  }
  return out;
}

/** 区切りを隙間(トークン)で持つ帯。 */
const BARS = [
  "[data-pkc-field='detail-toolbar']",
  "[data-pkc-region='format-bar']",
  "[data-pkc-region='collection-bar']",
  "[data-pkc-region='create-bar']",
  "[data-pkc-region='find-bar']",
  "[data-pkc-region='create-menu']",
  "[data-pkc-region='dual-commands']",
  "[data-pkc-region='inspector'] [data-pkc-field='inspector-actions']",
  "[data-pkc-region='inspector'] [data-pkc-field='inspector-action-group']",
];

describe('折り返す帯の区切りは隙間(#1982 段 2)', () => {
  it('🔴 空振り防止 ── 折り返す帯が 8 本以上見つかり、名指しの 9 本の規則も拾える', () => {
    const text = css();
    expect(wrappingBars(text).length, '折り返す帯の走査が壊れている').toBeGreaterThanOrEqual(8);
    for (const sel of BARS) {
      expect(blocksFor(text, sel).length, `${sel} の規則が拾えない(名前を変えた?)`).toBeGreaterThan(0);
    }
  });

  it('🔴 折り返す帯の下地に線色を使わない ── 最後の段以外の余りがベタ塗りになる', () => {
    const bad = wrappingBars(css())
      .filter(({ body }) => decl('background', 'var\\(--border\\)').test(body))
      .map((b) => b.sel);
    expect(bad, `下地が線色の帯が残っている: ${bad.join(' / ')}`).toEqual([]);
  });

  it('🔴 帯の区切りは `gap: 1px` ではなく隙間(`--s*`)── 1px の透かしの格子へ戻さない', () => {
    const text = css();
    const bad: string[] = [];
    for (const sel of BARS) {
      const joined = blocksFor(text, sel).join('\n');
      if (decl('gap', '1px').test(joined)) bad.push(sel);
      expect(joined, `${sel}: 隙間(gap)が無い`).toMatch(/gap:\s*var\(--s[1-6]\)/);
    }
    expect(bad, `1px の gap に戻っている帯: ${bad.join(' / ')}`).toEqual([]);
  });

  it('🔴 輪(`outline: 1px solid var(--border)`)で区切る規則が 1 つも無い', () => {
    const ring = rules(css()).filter((r) => decl('outline', '1px solid var\\(--border\\)').test(r.body));
    expect(
      ring.map((r) => r.sels.join(' , ')),
      '区切りの輪が戻っている',
    ).toEqual([]);
  });

  it('🔴 帯の中のボタンの地を `--surface` で塗りつぶさず、角を落とさない ── 型(標準 / ゴースト)が見た目を持つ', () => {
    const text = css();
    const bad: string[] = [];
    for (const sel of BARS) {
      const joined = blocksFor(text, `${sel} button`).join('\n');
      if (decl('background', 'var\\(--surface\\)').test(joined)) bad.push(`${sel}(地)`);
      if (decl('border-radius', '0').test(joined)) bad.push(`${sel}(角丸 0)`);
    }
    expect(bad, `ボタンの見た目を帯が上書きしている: ${bad.join(' / ')}`).toEqual([]);
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
