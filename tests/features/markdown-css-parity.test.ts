/** @vitest-environment node */
/**
 * P8 段⑳: markdown が**出している class に CSS が在る**か。
 *
 * 🔴 生まれた理由: renderer だけ PKC2 から流用して、対応する stylesheet
 * (PKC2 の `styles/base.css`)を持ってこなかったため、`markdown-render.ts` が
 * 吐く 36 個の `pkc-*` のうち **35 個に規則が 1 行も無かった**。残る 1 個
 * (`.pkc-toc`)も**誰も出していない名前**で、当たっていなかった。
 * いちばん見えていたのは「描いた図の**下に原文が丸ごと出る**」こと ──
 * 隠す規則(`.pkc-render-source`)が存在しなかったためである。
 *
 * ⚠ **逆向きも見る**(CLAUDE.md「tripwire は上限だけでなく下限も置く」)──
 * 「CSS に書いてあるが誰も出さない」規則は、**直したつもりで直っていない**
 * ことの証拠になる(`.pkc-toc` がまさにそれだった)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/features/markdown/markdown-render.ts', 'utf8');
const CSS = readFileSync('src/styles/app.css', 'utf8');

/** 実装が吐く `pkc-*` class(test に別表を持たない ── 表は必ず古くなる)。 */
function emitted(): string[] {
  const out = new Set<string>();
  for (const m of SRC.matchAll(/class="([a-z0-9 -]+)"/g))
    for (const c of m[1]!.split(' ')) if (c.startsWith('pkc-')) out.add(c);
  for (const m of SRC.matchAll(/className = '([a-z0-9 -]+)'/g))
    for (const c of m[1]!.split(' ')) if (c.startsWith('pkc-')) out.add(c);
  return [...out].sort();
}

/** `app.css` が言及している `pkc-*` class。 */
function styled(): Set<string> {
  const out = new Set<string>();
  for (const m of CSS.matchAll(/\.(pkc-[a-z0-9-]+)/g)) out.add(m[1]!);
  return out;
}

/**
 * 規則を持たなくてよいもの。**理由を書かずに足さない** ── ここが
 * 「例外を足せば通る」抜け道になると、この test は何も守らなくなる。
 */
const NO_STYLE_NEEDED: Readonly<Record<string, string>> = {
  // 器そのもの(中身の規則が `.pkc-md-rendered X` で当たる)
  'pkc-md-rendered': '本文の器。中の要素に当てる起点で、自身は素のまま',
  // 図の実体は adapter 側が差し替える。器の規則は data 属性側で当てている
  'pkc-mermaid-placeholder': '器。状態は data-pkc-mermaid-state で見る',
};

describe('markdown の描画物と CSS', () => {
  it('🔴 出している class に**全部** CSS が在る', () => {
    const list = emitted();
    // 空振り防止 ── renderer が吐かなくなったら「全部在る」は自明に通る
    expect(list.length, 'markdown が pkc-* を吐いていない').toBeGreaterThanOrEqual(30);
    const have = styled();
    const missing = list.filter((c) => !have.has(c) && !(c in NO_STYLE_NEEDED));
    expect(missing, `CSS の無い class: ${missing.join(', ')}`).toEqual([]);
  });

  it('🔴 CSS に**誰も出さない** `pkc-*` の規則が残っていない', () => {
    // ⚠ 直したつもりで直っていないことの証拠になる(`.pkc-toc` がそれだった ──
    //    renderer が出すのは `pkc-toc-formal` / `pkc-toc-preview` なので当たらない)
    const list = new Set(emitted());
    // markdown 以外(コード色分け)の class はここでは見ない
    const orphan = [...styled()].filter(
      (c) => !list.has(c) && !c.startsWith('pkc-tok-') && !(c in NO_STYLE_NEEDED),
    );
    expect(orphan, `誰も出さない規則: ${orphan.join(', ')}`).toEqual([]);
  });

  /**
   * 🔴 **描画の下に原文を出さない**。段⑳ 以前の実際の姿がこれで、
   * 「図は描いたら焼く」で得たきれいな 1 枚が直下の生ソースで台無しだった。
   */
  it('🔴 既定(`-both`)では原文が隠れ、切替で入れ替わる', () => {
    expect(CSS, '原文を隠す規則が無い').toContain('.pkc-render-source');
    // 向きは `copy-md-block.ts`(checked = ソース面)と一致していること
    expect(CSS).toMatch(/:not\(:checked\)\s*~\s*\.pkc-render-source/);
    expect(CSS).toMatch(/:checked\s*~\s*\.pkc-render-slot/);
    // `-render` は切替が無いので常に隠す
    expect(CSS).toContain("[data-pkc-render-mode='render'] > .pkc-render-source");
    // ⚠ 切替は `display: none` にしない(キーボードで到達できなくなる)
    const at = CSS.indexOf('.pkc-render-toggle-input {');
    expect(at, '切替の規則が無い').toBeGreaterThanOrEqual(0);
    expect(CSS.slice(at, CSS.indexOf('}', at))).not.toContain('display: none');
  });
});
