/**
 * 🔴 **帯に出さない 4 記法**(#425 段②-a)── ハイライト / ルビ / 圏点 / 打ち消し。
 *
 * ⚠ 描き手は前から読めるのに、**押して入れる口が 1 つも無かった**。
 * 🔑 ここが見るのは**綴りが描き手と噛み合っているか** ── 入れた字を
 *   `markdown-render` が実際に読めなければ、入口を作った意味が無い。
 */
import { describe, expect, it } from 'vitest';
import { applyFormat, BAR_FORMAT_OPS, FORMAT_OPS } from '../../src/features/markdown/text-ops';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const at = (text: string, start: number, end: number) => ({ text, start, end });

describe('帯に出さない記法(#425 段②-a)', () => {
  it('🔴 帯の表と全体の表が違う ── 5 つだけ落ちている(mermaid は #528 案 B で「先に聞く」側へ)', () => {
    const off = FORMAT_OPS.filter((o) => o.onBar === false).map((o) => o.op);
    expect(off).toEqual(['mermaid', 'highlight', 'ruby', 'emdot', 'strike']);
    // ⚠ 空振り防止 ── 帯の側にその 5 つが 1 つも居ないこと
    const bar = new Set(BAR_FORMAT_OPS.map((o) => o.op));
    expect(off.filter((o) => bar.has(o)), '帯にも出てしまっている').toEqual([]);
    expect(BAR_FORMAT_OPS.length, '帯が空になった').toBeGreaterThan(10);
  });

  describe('選んだ範囲を囲む(もう一度押すと外れる)', () => {
    for (const [op, mark] of [
      ['highlight', '=='],
      ['emdot', '^^'],
      ['strike', '~~'],
    ] as const) {
      it(`${op} は ${mark} で囲み、もう一度で外れる`, () => {
        const on = applyFormat(at('あいう', 0, 3), op);
        expect(on.text).toBe(`${mark}あいう${mark}`);
        // 🔑 **戻せる**(トグル)── 囲んだ範囲を選び直して押す
        const off = applyFormat(at(on.text, on.start, on.end), op);
        expect(off.text, 'もう一度押しても外れない').toBe('あいう');
      });
    }
  });

  describe('ルビ', () => {
    it('🔴 選んだ字が base になり、caret は**読みの位置**へ入る', () => {
      const r = applyFormat(at('漢字', 0, 2), 'ruby');
      expect(r.text).toBe('[[ruby:漢字|]]');
      // ⚠ 次に打つのは読みなので、`|` の直後で止まっていること
      expect(r.text.slice(0, r.start)).toBe('[[ruby:漢字|');
      expect(r.start).toBe(r.end);
    });

    it('選んでいなければ base の位置へ入る(打ち始められる)', () => {
      const r = applyFormat(at('', 0, 0), 'ruby');
      expect(r.text).toBe('[[ruby:|]]');
      expect(r.text.slice(0, r.start)).toBe('[[ruby:');
    });
  });

  /**
   * 🔴 **入れた字を、描き手が実際に読めるか**(いちばん大事な検算)。
   *
   * ⚠ 綴りは `markdown-render.ts` から引いたが、**引き写しが正しい保証は無い** ──
   *   だから**描かせて確かめる**(期待値を実装の別の綴りで組まない ── §1)。
   */
  it('🔴 入れた字が、描き手にそのまま通る', () => {
    const html = (op: 'highlight' | 'emdot' | 'strike' | 'ruby', sel: string) =>
      renderMarkdown(applyFormat(at(sel, 0, sel.length), op).text);
    expect(html('highlight', 'あ'), 'ハイライトが描かれない').toMatch(/<mark\b/);
    expect(html('emdot', 'あ'), '圏点が描かれない').toMatch(/pkc-em-dot/);
    expect(html('strike', 'あ'), '打ち消しが描かれない').toMatch(/<s\b|<del\b/);
    // ⚠ ルビは読みが空だと `<ruby>` にならないことがある ── 読みを入れて見る
    const ruby = applyFormat(at('漢字', 0, 2), 'ruby');
    const filled = ruby.text.slice(0, ruby.start) + 'かんじ' + ruby.text.slice(ruby.start);
    expect(renderMarkdown(filled), 'ルビが描かれない').toMatch(/<ruby\b/);
  });
});
