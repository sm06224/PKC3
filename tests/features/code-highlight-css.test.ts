/** @vitest-environment node */
/**
 * P8 段⑲: コードの色分けが**実際に画面に出ている**か。
 *
 * 🔴 直す前は `code-highlight.ts` が 15 種の `pkc-tok-*` を吐いていたのに、
 * **当てる CSS がどこにも無かった** ── ソースのコメントは
 * 「`styles/base.css` に scoped してある」と書いていたが、その file は
 * PKC2 のものであり PKC3 に存在しない(流用でコメントだけが渡ってきた)。
 * 結果、色分けは**全部が地の色**で、`<span>` を出すだけの死んだ markup だった。
 *
 * ⚠ **「CSS に `pkc-tok` の語が在るか」では当てられない** ── 1 種類でも書けば
 * 満たされるので、14 種を落としても通る。**吐いている種の全部**を突合する。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { highlightCode } from '../../src/features/markdown/code-highlight';

const CSS = readFileSync('src/styles/app.css', 'utf8');
const SRC = readFileSync('src/features/markdown/code-highlight.ts', 'utf8');

/** 実装が吐きうる class を**実装から**読む(test に別表を持たない)。 */
function emittedClasses(): string[] {
  const out = new Set<string>();
  for (const m of SRC.matchAll(/'(pkc-tok-[a-z]+)'/g)) out.add(m[1]!);
  return [...out].sort();
}

describe('コードの色分け', () => {
  it('🔴 吐いている `pkc-tok-*` は**全部** CSS で色が当たっている', () => {
    const kinds = emittedClasses();
    // 空振り防止 ── 実装が吐かなくなったら「全部当たっている」は自明に通る
    expect(kinds.length, '`pkc-tok-*` を 1 つも吐いていない').toBeGreaterThanOrEqual(10);
    const missing = kinds.filter((c) => !CSS.includes(`.${c}`));
    expect(missing, `色の当たっていない種: ${missing.join(', ')}`).toEqual([]);
  });

  it('🔴 色の実体は `tokens.css` にしかない(app.css に直値を書かない)', () => {
    // 当該規則のかたまりだけを見る(他の規則の色まで縛らない)
    const at = CSS.indexOf('.pkc-md-rendered pre code .pkc-tok-comment');
    expect(at, 'コードの色の規則が消えている').toBeGreaterThanOrEqual(0);
    const block = CSS.slice(at, CSS.indexOf('\n}\n', CSS.indexOf('pkc-tok-del')) + 3);
    expect(block, 'app.css に 16 進の色を直書きしている').not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(block).toContain('var(--code-key)');
    expect(block).toContain('var(--code-lit)');
  });

  /**
   * ⚠ **CSS の側だけ見ても足りない** ── 実装が class を付け忘れていたら、
   * 規則は在るのに何にも当たらない。実際に色分けさせて、
   * `--code-key` / `--code-lit` の**両方**の系統が出ることを確かめる。
   */
  it('🔴 実際に色分けすると、3 系統がそろって出る', () => {
    const html = highlightCode('const x = "あ"; // 注', 'js');
    expect(html, '予約語に印が付いていない').toContain('pkc-tok-keyword');
    expect(html, '文字列に印が付いていない').toContain('pkc-tok-string');
    expect(html, '注釈に印が付いていない').toContain('pkc-tok-comment');
    // 中身は escape されている(`<` が生で出ない)
    expect(highlightCode('const a = "<div>";', 'js')).not.toContain('"<div>"');
  });
});
