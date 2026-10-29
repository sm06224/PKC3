/** @vitest-environment node */
/**
 * 🔴 **帯に出さない 4 記法**(#425 段②-a)── ハイライト / ルビ / 圏点 / 打ち消し。
 *
 * ⚠ 描き手は前から読めるのに、**押して入れる口が 1 つも無かった**。
 * 🔑 ここが見るのは**綴りが描き手と噛み合っているか** ── 入れた字を
 *   `markdown-render` が実際に読めなければ、入口を作った意味が無い。
 */
import { describe, expect, it } from 'vitest';
import { applyFormat, BAR_FORMAT_OPS, CALLOUT_CHOICES, calloutRoleOf, FORMAT_OPS } from '../../src/features/markdown/text-ops';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const at = (text: string, start: number, end: number) => ({ text, start, end });

describe('帯に出さない記法(#425 段②-a)', () => {
  it('🔴 帯の表と全体の表が違う ── 5 つだけ落ちている(mermaid は #528 案 B で「先に聞く」側へ)', () => {
    const off = FORMAT_OPS.filter((o) => o.onBar === false).map((o) => o.op);
    expect(off.slice(0, 5)).toEqual(['mermaid', 'highlight', 'ruby', 'emdot', 'strike']);
    // 🔴 #425: 注意書きのブロック 8 種も帯には出さない(帯には「注意書きを入れる」1 つ)
    expect(off.slice(5)).toEqual(CALLOUT_CHOICES.map((c) => `callout-${c.role}`));
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

describe('注意書きのブロック 8 種(#425 の「囲い」)', () => {
  it('🔴 選んでいなければ空のブロック、caret は中', () => {
    const r = applyFormat(at('', 0, 0), 'callout-warning');
    expect(r.text).toBe(':::warning\n\n:::\n');
    expect(r.text.slice(0, r.start)).toBe(':::warning\n');
  });

  it('🔴 選んでいればその範囲を囲み、もう一度で外れる(片道にしない)', () => {
    const on = applyFormat(at('あいう', 0, 3), 'callout-note');
    expect(on.text).toBe(':::note\nあいう\n:::');
    const off = applyFormat(at(on.text, on.start, on.end), 'callout-note');
    expect(off.text, 'もう一度押しても外れない').toBe('あいう');
  });

  it('🔴 8 種すべて、入れた字を描き手が注意書きとして描く(綴りの引き写しの検算)', () => {
    expect(CALLOUT_CHOICES.length).toBe(8);
    for (const c of CALLOUT_CHOICES) {
      const html = renderMarkdown(applyFormat(at('あいう', 0, 3), `callout-${c.role}`).text);
      expect(html, `${c.role} が注意書きとして描かれない`).toMatch(
        new RegExp(`pkc-section-callout[^"]*pkc-section-${c.role === 'summary' ? 'summary' : c.role}|data-pkc-role="${c.role}"`),
      );
      expect(html).toContain('あいう');
    }
  });

  it('🔴 空のブロックの中にカーソルがあるとき、もう一度押すと外れる(入れる → 外す の往復)', () => {
    const on = applyFormat(at('まえ\nうしろ', 3, 3), 'callout-warning');
    expect(on.text).toBe('まえ\n:::warning\n\n:::\n\nうしろ'); // 後ろに字が続くので閉じの後に空行が入る
    // caret は中(空行)── そこでもう一度
    const off = applyFormat(at(on.text, on.start, on.end), 'callout-warning');
    expect(off.text, '空のブロックが外れない').toBe('まえ\n\nうしろ');
    // 閉じの行の上にカーソルがあっても外れる / 開きの行でも外れる
    const closeAt = on.text.indexOf('\n:::\n') + 1;
    expect(applyFormat(at(on.text, closeAt, closeAt), 'callout-warning').text).toBe('まえ\n\nうしろ');
    const openAt = on.text.indexOf(':::warning');
    expect(applyFormat(at(on.text, openAt, openAt), 'callout-warning').text).toBe('まえ\n\nうしろ');
    // 末尾のブロックでも落ちない
    const tail = applyFormat(at('', 0, 0), 'callout-note');
    expect(applyFormat(at(tail.text, tail.start, tail.end), 'callout-note').text).toBe('');
  });

  it('🔴 外さない場面(対照群): 中身があるブロック / 別の種類のブロックの中 / ブロックの外', () => {
    // 中身がある ── 消さない(新しく入れ子に入る)
    const full = ':::note\nあい\n:::\n';
    expect(applyFormat(at(full, 8, 8), 'callout-note').text, '中身のあるブロックを消した').toContain('あい');
    // 別の種類の空ブロックの中 ── 勝手に消さず、新しく入れる
    const other = ':::note\n\n:::\n';
    const r = applyFormat(at(other, 8, 8), 'callout-warning');
    expect(r.text, '別の種類の空ブロックを消した').toContain(':::note');
    expect(r.text).toContain(':::warning');
    // ブロックの外(後ろの段落)── 外ではなく新しく入る
    const outside = ':::note\n\n:::\nあと';
    const o = applyFormat(at(outside, outside.length, outside.length), 'callout-note');
    expect(o.text, 'ブロックの外で押したのに既存のブロックが消えた').toContain('あと');
    expect((o.text.match(/:::note/g) ?? []).length).toBe(2);
  });

  it('種類でない op は注意書きとして読まない(対照群)', () => {
    expect(calloutRoleOf('callout-nothing')).toBeNull();
    expect(calloutRoleOf('bold')).toBeNull();
    expect(calloutRoleOf('callout-tip')).toBe('tip');
  });
});
