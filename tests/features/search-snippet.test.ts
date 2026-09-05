/**
 * 探す面の抜粋の印(#680)── `features/filter/search-snippet.ts`。
 *
 * 🔴 守る主張:
 * 1. 印で囲まれた抜粋を **`{ text, hit }` の並び**へ割れる(描画器が `<mark>` を組む材料)
 * 2. 窓の端で開いたまま切れた印でも**字を落とさない**
 * 3. LIKE 側の抜粋(`excerptAround`)が FTS の `snippet()` と**同じ顔**になる
 *    ── 前後を切る / 同じ印で囲む / 大小を区別しない / 無ければ頭を返す
 */
import { describe, expect, it } from 'vitest';
import {
  excerptAround,
  SNIPPET_ELLIPSIS,
  SNIPPET_MARK_CLOSE,
  SNIPPET_MARK_OPEN,
  splitSnippet,
} from '../../src/features/filter/search-snippet';

const O = SNIPPET_MARK_OPEN;
const C = SNIPPET_MARK_CLOSE;

describe('splitSnippet', () => {
  it('印で囲んだ所だけ hit になる', () => {
    expect(splitSnippet(`来週の${O}全文検索${C}の設計`)).toEqual([
      { text: '来週の', hit: false },
      { text: '全文検索', hit: true },
      { text: 'の設計', hit: false },
    ]);
  });

  it('印が 2 つ以上あっても、印の字そのものは出さない', () => {
    const parts = splitSnippet(`${O}a${C} と ${O}b${C}`);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['a', 'b']);
    expect(parts.map((p) => p.text).join('')).toBe('a と b');
  });

  it('🔴 開いたまま切れた印でも字を落とさない(窓の端で切れた形)', () => {
    expect(splitSnippet(`りんご${O}全文検`)).toEqual([
      { text: 'りんご', hit: false },
      { text: '全文検', hit: true },
    ]);
  });

  it('印が無ければ 1 つの素の字', () => {
    expect(splitSnippet('本文の頭')).toEqual([{ text: '本文の頭', hit: false }]);
    expect(splitSnippet('')).toEqual([]);
  });
});

describe('excerptAround(LIKE 側の抜粋)', () => {
  it('🔴 当たった語を同じ印で囲み、前後を切って両端に … を置く', () => {
    const body = 'あ'.repeat(100) + '買う' + 'い'.repeat(100);
    const out = excerptAround(body, '買う', 20);
    expect(out).toContain(`${O}買う${C}`);
    expect(out.startsWith(SNIPPET_ELLIPSIS), '前が切れているのに … が無い').toBe(true);
    expect(out.endsWith(SNIPPET_ELLIPSIS), '後ろが切れているのに … が無い').toBe(true);
    // 前後 9 字ずつ((20 - 2) / 2)── 本文を丸ごと返していない
    expect([...out].length).toBeLessThan(30);
  });

  it('短い本文はそのまま(… を付けない)', () => {
    expect(excerptAround('りんごを買う', '買う')).toBe(`りんごを${O}買う${C}`);
  });

  it('大小を区別しない(LIKE と同じ)── ただし字は本文のまま出す', () => {
    expect(excerptAround('Read the README now', 'readme')).toBe(`Read the ${O}README${C} now`);
  });

  it('🔴 本文に無ければ(題名だけの当たり)先頭を返す ── snippet() と同じ振る舞い', () => {
    const out = excerptAround('本文には別の話しか無い。' + 'x'.repeat(100), 'ない語', 10);
    expect(out).not.toContain(O);
    expect(out.startsWith('本文には別の話しか無')).toBe(true);
    expect(out.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  });

  it('改行は空白へ潰す(1 行に出す)', () => {
    expect(excerptAround('1 行目\n2 行目に買う', '買う')).toBe(`1 行目 2 行目に${O}買う${C}`);
  });

  it('絵文字を半分に割らない(幅は code point で数える)', () => {
    const out = excerptAround('😀'.repeat(30) + '買う' + '😀'.repeat(30), '買う', 10);
    expect(out).toContain(`${O}買う${C}`);
    // ⚠ `for…of` は code point 単位 ── 対になっていないサロゲートだけが長さ 1 で残る
    for (const ch of out) {
      expect(ch.length === 1 && /[\ud800-\udfff]/.test(ch), `孤立サロゲート: ${ch}`).toBe(false);
    }
    // 前後 4 つずつ(10 - 2 = 8 の半分)── 絵文字を字として数えている
    expect([...out].filter((c) => c === '😀'), '絵文字を 2 字と数えている').toHaveLength(8);
  });
});
