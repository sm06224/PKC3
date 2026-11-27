/** @vitest-environment node */
/**
 * 🔴 **Word のような書式**(v4.0 Phase 1 / PR-04)── 取り消し線・ハイライト・下線・文字色・段落の揃え・字下げ・改ページ。
 *
 * 見るのは 3 つ:
 *   ① 純関数の書き換え(選択あり / 選択なし / 再適用で外れる / 入れ子にしない)
 *   ② 入れた字を描き手(`markdown-render`)が本当に読めるか(綴りの噛み合い)
 *   ③ 帯の並びに書式が 1 つも落ちていないか(`formatOpsMissingFromLayout`)
 * ⚠ 期待値は固定の字で書く(実装と同じ正規表現・ヘルパーで作らない)。
 */
import { describe, expect, it } from 'vitest';
import { applyFormat, type TextSelection } from '../../../src/features/markdown/text-ops';
import {
  applyTextColor,
  BLOCK_CROSS_REFUSAL,
  IN_CODE_REFUSAL,
  IN_FRONTMATTER_REFUSAL,
  IN_TABLE_REFUSAL,
  INLINE_MARK_REFUSAL,
  inlineMarksIn,
  insertPageBreak,
  refusalOf,
  TEXT_COLORS,
  textColorValue,
} from '../../../src/features/markdown/word-format';
import { formatOpsMissingFromLayout } from '../../../src/features/markdown/format-bar-layout';
import { renderMarkdown } from '../../../src/features/markdown/markdown-render';

const at = (text: string, start: number, end = start): TextSelection => ({ text, start, end });
/** 本文の中の字 `needle` を選んだ状態。 */
const pick = (text: string, needle: string): TextSelection => {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`${needle} が本文に無い`);
  return at(text, i, i + needle.length);
};
const RED = textColorValue('red')!;
const BLUE = textColorValue('blue')!;

describe('取り消し線・ハイライト(トグル)', () => {
  for (const [op, mark] of [
    ['strike', '~~'],
    ['highlight', '=='],
  ] as const) {
    it(`${op}: 選んで押すと ${mark} で囲み、もう一度で外れる`, () => {
      const on = applyFormat(pick('前 あいう 後', 'あいう'), op);
      expect(on.text).toBe(`前 ${mark}あいう${mark} 後`);
      expect(on.text.slice(on.start, on.end)).toBe('あいう');
      const off = applyFormat(on, op);
      expect(off.text).toBe('前 あいう 後');
    });
    it(`${op}: 選ばずに押すと記号だけ入り、カーソルは間`, () => {
      const r = applyFormat(at('', 0), op);
      expect(r.text).toBe(`${mark}${mark}`);
      expect(r.start).toBe(mark.length);
      expect(r.end).toBe(mark.length);
    });
    it(`${op}: 囲み済みの範囲に押しても二重にならない(外れる)`, () => {
      const text = `x ${mark}abc${mark} y`;
      const r = applyFormat(pick(text, `${mark}abc${mark}`), op);
      expect(r.text).toBe('x abc y');
    });
  }
});

describe('下線(`:字:underline:`)', () => {
  it('選んで押すと囲み、もう一度で外れる', () => {
    const on = applyFormat(pick('前 下線 後', '下線'), 'underline');
    expect(on.text).toBe('前 :下線:underline: 後');
    expect(on.text.slice(on.start, on.end)).toBe('下線');
    const off = applyFormat(on, 'underline');
    expect(off.text).toBe('前 下線 後');
    expect(off.text.slice(off.start, off.end)).toBe('下線');
  });

  it('選ばずに押すと空の囲みを入れ、カーソルは中身の位置', () => {
    const r = applyFormat(at('', 0), 'underline');
    expect(r.text).toBe('::underline:');
    expect(r.start).toBe(1);
  });

  it('カーソルが囲みの中に居れば、その囲みの下線を外す', () => {
    const text = ':下線:underline:';
    const r = applyFormat(at(text, 2), 'underline');
    expect(r.text).toBe('下線');
  });

  it('🔴 色の付いた字に下線を足すと、同じ囲みの属性に足す(入れ子にしない)', () => {
    const text = `a :字:${RED}: b`;
    const r = applyFormat(pick(text, '字'), 'underline');
    expect(r.text).toBe(`a :字:${RED}, underline: b`);
    // 外すと色だけ残る
    const off = applyFormat(r, 'underline');
    expect(off.text).toBe(`a :字:${RED}: b`);
  });

  it('囲みごと選んで押しても外れる(印ごとの選択)', () => {
    const text = 'x :abc:underline: y';
    const r = applyFormat(pick(text, ':abc:underline:'), 'underline');
    expect(r.text).toBe('x abc y');
  });

  it('複数行は行ごとに囲み、行頭の印(リスト)の外に置く', () => {
    const text = '- 一つ目\n- 二つ目';
    const r = applyFormat(at(text, 0, text.length), 'underline');
    expect(r.text).toBe('- :一つ目:underline:\n- :二つ目:underline:');
    const off = applyFormat(r, 'underline');
    expect(off.text).toBe(text);
  });

  it('表の行を含む選択は何もしない(表を壊さない)', () => {
    const text = '| a | b |';
    expect(applyFormat(at(text, 0, text.length), 'underline').text).toBe(text);
  });
});

describe('文字色(`:字:#rrggbb:`)', () => {
  it('見本は 6 色で、どれも描き手が読める #rrggbb', () => {
    expect(TEXT_COLORS.map((c) => c.label)).toEqual(['赤', '橙', '緑', '青', '紫', '灰']);
    for (const c of TEXT_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
    expect(textColorValue('nope')).toBeNull();
  });

  it('選んで色を付けると囲む', () => {
    const r = applyTextColor(pick('前 赤い字 後', '赤い字'), RED);
    expect(r.text).toBe(`前 :赤い字:${RED}: 後`);
    expect(r.text.slice(r.start, r.end)).toBe('赤い字');
  });

  it('🔴 別の色を選ぶと色だけ差し替える(入れ子にならない)', () => {
    const red = applyTextColor(pick('前 字 後', '字'), RED);
    const blue = applyTextColor(red, BLUE);
    expect(blue.text).toBe(`前 :字:${BLUE}: 後`);
    expect(blue.text.split(':').length - 1, '囲みが増えた').toBe(3);
  });

  it('カーソルだけでも、囲みの中なら色を差し替える', () => {
    const text = `:あいう:${RED}:`;
    const r = applyTextColor(at(text, 2), BLUE);
    expect(r.text).toBe(`:あいう:${BLUE}:`);
    expect(r.start).toBe(2);
  });

  it('🔴 「色を解除」で囲みを剥がして元の字に戻す(片道にしない)', () => {
    const red = applyTextColor(pick('前 字 後', '字'), RED);
    const off = applyTextColor(red, null);
    expect(off.text).toBe('前 字 後');
    expect(off.text.slice(off.start, off.end)).toBe('字');
  });

  it('解除は色だけを外す(下線は残す)', () => {
    const text = `:字:underline, ${RED}:`;
    const r = applyTextColor(at(text, 1), null);
    expect(r.text).toBe(':字:underline:');
  });

  it('色の無い所で解除しても何も変わらない', () => {
    const sel = pick('ただの字', 'ただ');
    expect(applyTextColor(sel, null)).toEqual(sel);
  });

  it('囲みに一部だけ掛かる選択は、囲みごと 1 つにまとめる(入れ子にしない)', () => {
    const text = `あ:いう:${RED}:え`;
    const r = applyTextColor(at(text, 0, 3), BLUE); // 「あ:い」
    expect(r.text).toBe(`:あいう:${BLUE}:え`);
  });

  it('選んだ範囲の中の囲みは外して 1 つに畳む', () => {
    const text = `一 :二:${RED}: 三`;
    const r = applyTextColor(at(text, 0, text.length), BLUE);
    expect(r.text).toBe(`:一 二 三:${BLUE}:`);
  });

  it('時刻の `12:30:45` を囲みと読まない(描き手と同じ判定)', () => {
    expect(inlineMarksIn('12:30:45', 0, 8)).toEqual([]);
    expect(inlineMarksIn('`:a:red:`', 0, 9), 'コードの中').toEqual([]);
  });
});

describe('段落の揃え(`:::format{align=…}`)', () => {
  it('段落を囲み、中身の選択はそのまま', () => {
    const text = '前\n\n本文の段落\n\n後';
    const r = applyFormat(at(text, text.indexOf('本文') + 1), 'align-center');
    expect(r.text).toBe('前\n\n:::format{align=center}\n本文の段落\n:::\n\n後');
    expect(r.text.slice(r.start, r.start + 2)).toBe('文の');
  });

  it('複数行の段落は丸ごと囲む', () => {
    const text = '一行目\n二行目';
    const r = applyFormat(at(text, 1), 'align-right');
    expect(r.text).toBe(':::format{align=right}\n一行目\n二行目\n:::');
  });

  it('🔴 別の揃えを選ぶと align= だけ差し替える(入れ子にしない)', () => {
    const c = applyFormat(at('段落', 1), 'align-center');
    const r = applyFormat(c, 'align-right');
    expect(r.text).toBe(':::format{align=right}\n段落\n:::');
  });

  it('🔴 同じ揃えをもう一度選ぶと外れ、枠ごと剥がれる', () => {
    const c = applyFormat(at('段落', 1), 'align-center');
    const off = applyFormat(c, 'align-center');
    expect(off.text).toBe('段落');
    expect(off.start).toBe(1);
  });

  it('🔴 「揃えを解除」で外れる', () => {
    const c = applyFormat(at('段落', 1), 'align-left');
    expect(applyFormat(c, 'align-clear').text).toBe('段落');
  });

  it('枠の無い所で「揃えを解除」は何もしない', () => {
    const sel = at('段落', 1);
    expect(applyFormat(sel, 'align-clear')).toEqual(sel);
  });

  it('🔴 indent= と同じ開きの行に同居し、片方を外しても枠は残る', () => {
    const ind = applyFormat(at('段落', 1), 'indent-more');
    expect(ind.text).toBe(':::format{indent=1}\n段落\n:::');
    const both = applyFormat(ind, 'align-center');
    expect(both.text).toBe(':::format{indent=1 align=center}\n段落\n:::');
    const noAlign = applyFormat(both, 'align-clear');
    expect(noAlign.text).toBe(':::format{indent=1}\n段落\n:::');
  });

  it('ほかの属性(class)を持つ枠は、揃えを外しても枠を残す', () => {
    const text = ':::format{.note align=center}\n段落\n:::';
    expect(applyFormat(at(text, text.indexOf('段落')), 'align-clear').text).toBe(':::format{.note}\n段落\n:::');
  });

  it('枠の開きの行にカーソルがあっても(1 画面編集の行が枠ごとのとき)、その枠を書き換える', () => {
    const text = ':::format{align=center}\n段落\n:::';
    expect(applyFormat(at(text, 3), 'align-right').text).toBe(':::format{align=right}\n段落\n:::');
  });

  it('空行で押すと空の枠を入れ、中にカーソルを置く', () => {
    const r = applyFormat(at('a\n\nb', 2), 'align-center');
    expect(r.text).toBe('a\n:::format{align=center}\n\n:::\nb');
    expect(r.text.slice(0, r.start)).toBe('a\n:::format{align=center}\n');
  });

  it('見出しの行は見出しだけを囲む(下の段落を巻き込まない)', () => {
    const text = '# 題\n本文';
    expect(applyFormat(at(text, 2), 'align-center').text).toBe(':::format{align=center}\n# 題\n:::\n本文');
  });

  it('コードブロックの中の `:::` を枠と読まない', () => {
    const text = '```\n:::format{align=center}\n```\n\n段落';
    const r = applyFormat(at(text, text.indexOf('段落')), 'align-right');
    expect(r.text).toBe('```\n:::format{align=center}\n```\n\n:::format{align=right}\n段落\n:::');
  });
});

describe('字下げ', () => {
  it('🔴 通常の段落は indent=1..4 で増え、4 で止まる', () => {
    let s = at('段落', 0);
    for (let n = 1; n <= 4; n += 1) {
      s = applyFormat(s, 'indent-more');
      expect(s.text).toBe(`:::format{indent=${n}}\n段落\n:::`);
    }
    expect(applyFormat(s, 'indent-more').text, '4 段を超えた').toBe(s.text);
  });

  it('🔴 減らすと段が下がり、0 で枠ごと剥がれる', () => {
    let s = applyFormat(applyFormat(at('段落', 0), 'indent-more'), 'indent-more');
    s = applyFormat(s, 'indent-less');
    expect(s.text).toBe(':::format{indent=1}\n段落\n:::');
    s = applyFormat(s, 'indent-less');
    expect(s.text).toBe('段落');
  });

  it('揃えのある枠で 0 になっても、揃えは残る', () => {
    const text = ':::format{align=center indent=1}\n段落\n:::';
    expect(applyFormat(at(text, text.indexOf('段落')), 'indent-less').text).toBe(':::format{align=center}\n段落\n:::');
  });

  it('枠の無い段落で減らしても何も変わらない', () => {
    const sel = at('段落', 0);
    expect(applyFormat(sel, 'indent-less')).toEqual(sel);
  });

  it('🔴 リストの行は行頭の空白で 1 段ずつ(:::format で囲まない)', () => {
    const text = '- 親\n- 子';
    const line2 = text.indexOf('子');
    const more = applyFormat(at(text, line2), 'indent-more');
    expect(more.text).toBe('- 親\n  - 子');
    const less = applyFormat(more, 'indent-less');
    expect(less.text).toBe(text);
  });

  it('番号・チェックの行も同じ(複数行の選択)', () => {
    const text = '1. a\n- [ ] b';
    const r = applyFormat(at(text, 0, text.length), 'indent-more');
    expect(r.text).toBe('   1. a\n  - [ ] b');
  });
});

describe('改ページ(`+++`)', () => {
  it('段落の間に、前後の空行を整えて入れる', () => {
    const text = '前の段落\n後の段落';
    const r = insertPageBreak(at(text, '前の段落\n'.length));
    expect(r.text).toBe('前の段落\n\n+++\n\n後の段落');
    expect(r.text.slice(r.start)).toBe('後の段落');
  });

  it('行の途中なら行を分けて入れる', () => {
    const r = applyFormat(at('あいう', 1), 'pagebreak');
    expect(r.text).toBe('あ\n\n+++\n\nいう');
  });

  it('末尾に入れると、次の行の頭へカーソル', () => {
    const r = applyFormat(at('終わり', 3), 'pagebreak');
    expect(r.text).toBe('終わり\n\n+++\n');
    expect(r.start).toBe(r.text.length);
  });

  it('既に空行で挟まれていれば足さない', () => {
    const text = 'a\n\n\n\nb';
    const r = insertPageBreak(at(text, 3));
    expect(r.text).toBe('a\n\n+++\n\nb');
  });

  it('選んでいる字は消さない', () => {
    const r = applyFormat(pick('残す字', '残す'), 'pagebreak');
    expect(r.text).toContain('残す字');
  });
});

describe('🔴 構造を壊す書き換えは断る(本文は 1 字も変えず、理由を返す ── 着地前レビュー)', () => {
  it('🔴 枠の内側から外側へまたぐ選択で揃えても、無関係な段落の配置を変えない', () => {
    const text = ':::format{align=center}\nA\n:::\n\nB';
    const sel = at(text, text.indexOf('A'), text.length);
    for (const op of ['align-right', 'indent-more'] as const) {
      const r = applyFormat(sel, op);
      expect(r.text, `${op} が本文を変えた`).toBe(text);
      expect(refusalOf(r)).toBe(BLOCK_CROSS_REFUSAL);
    }
    // 描画も元のまま(B は中央揃えの枠に入らない)
    expect(renderMarkdown(text)).toMatch(/<\/div>\s*<p>B<\/p>/);
  });

  it('対照群: 枠の外の段落だけを選べば囲める', () => {
    const text = ':::format{align=center}\nA\n:::\n\nB';
    const r = applyFormat(at(text, text.length), 'align-right');
    expect(refusalOf(r)).toBeNull();
    expect(r.text).toBe(':::format{align=center}\nA\n:::\n\n:::format{align=right}\nB\n:::');
  });

  it('🔴 中身に「: 書式の語」が並ぶ字は、下線・色で囲まない(描き手が別の境目で切る)', () => {
    const text = 'Note: red';
    const u = applyFormat(at(text, 0, text.length), 'underline');
    expect(u.text).toBe(text);
    expect(refusalOf(u)).toBe(INLINE_MARK_REFUSAL);
    const c = applyTextColor(at(text, 0, text.length), RED);
    expect(c.text).toBe(text);
    expect(refusalOf(c)).toBe(INLINE_MARK_REFUSAL);
    // 対照群: 「:」があっても書式の語が続かなければ囲める(時刻)
    const ok = applyTextColor(at('12:30 です', 0, 5), RED);
    expect(refusalOf(ok)).toBeNull();
    expect(renderMarkdown(ok.text)).toContain('>12:30</span>');
  });

  it('🔴 空行を挟んだコードブロックの 2 つ目の塊・コードの中には、揃え・改ページを入れない', () => {
    const text = '```\na\n\nb\n```';
    const inB = at(text, text.indexOf('b'));
    expect(refusalOf(applyFormat(inB, 'align-center'))).toBe(IN_CODE_REFUSAL);
    expect(applyFormat(inB, 'align-center').text).toBe(text);
    expect(refusalOf(insertPageBreak(inB))).toBe(IN_CODE_REFUSAL);
    // 対照群: 空行の無いコードブロックは丸ごと囲める(fence の外で閉じる)
    const whole = '```\na\n```';
    expect(applyFormat(at(whole, 5), 'align-center').text).toBe(':::format{align=center}\n```\na\n```\n:::');
  });

  it('🔴 前書き(frontmatter)には、揃え・改ページを入れない', () => {
    const text = '---\npage_format: a4-landscape\n---\n本文';
    const inFm = at(text, 6);
    expect(refusalOf(applyFormat(inFm, 'align-center'))).toBe(IN_FRONTMATTER_REFUSAL);
    expect(refusalOf(insertPageBreak(inFm))).toBe(IN_FRONTMATTER_REFUSAL);
    // 対照群: 本文の段落は囲める(先頭の情報は残る)
    const r = applyFormat(at(text, text.length), 'align-center');
    expect(r.text).toBe('---\npage_format: a4-landscape\n---\n:::format{align=center}\n本文\n:::');
  });

  it('🔴 表の行の途中には改ページを入れない(行の頭・終わりなら入る)', () => {
    const text = '| a | b |\n|---|---|';
    expect(refusalOf(insertPageBreak(at(text, 3)))).toBe(IN_TABLE_REFUSAL);
    expect(refusalOf(insertPageBreak(at(text, text.length)))).toBeNull();
  });
});

describe('🔴 入れた字を描き手が読める(綴りの噛み合い)', () => {
  const html = (s: TextSelection): string => renderMarkdown(s.text);

  it('取り消し線 → <s>、ハイライト → <mark>', () => {
    expect(html(applyFormat(pick('x 消す y', '消す'), 'strike'))).toMatch(/<s>消す<\/s>/);
    expect(html(applyFormat(pick('x 目立つ y', '目立つ'), 'highlight'))).toMatch(/<mark>目立つ<\/mark>/);
  });

  it('下線 + 色 → 1 つの <span>(text-decoration と color の両方)', () => {
    const u = applyFormat(pick('x 字 y', '字'), 'underline');
    const both = applyTextColor(u, RED);
    const out = html(both);
    expect(out).toMatch(/<span class="pkc-inline-mark" style="[^"]*text-decoration: underline[^"]*">字<\/span>/);
    expect(out).toContain(`color: ${RED}`);
    expect(out.match(/<span class="pkc-inline-mark"/g)?.length, '入れ子').toBe(1);
    // 解除すると span が消える
    expect(html(applyFormat(applyTextColor(both, null), 'underline'))).not.toContain('pkc-inline-mark');
  });

  it('揃え・字下げ → data-pkc-align / data-pkc-indent。解除で消える', () => {
    const c = applyFormat(applyFormat(at('段落', 0), 'align-center'), 'indent-more');
    const out = html(c);
    expect(out).toContain('data-pkc-align="center"');
    expect(out).toContain('data-pkc-indent="1"');
    const cleared = applyFormat(applyFormat(c, 'align-clear'), 'indent-less');
    expect(html(cleared)).not.toContain('pkc-format-block');
    expect(cleared.text).toBe('段落');
  });

  it('改ページ → .pkc-section-break', () => {
    expect(html(applyFormat(at('前後', 1), 'pagebreak'))).toContain('class="pkc-section-break"');
  });
});

describe('帯の並び', () => {
  it('🔴 帯に出す書式は全部、直接 / ▾ の一覧 / その他 ▾ のどこかに居る', () => {
    expect(formatOpsMissingFromLayout()).toEqual([]);
  });
});
