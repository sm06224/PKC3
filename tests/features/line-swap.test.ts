/**
 * 🔴 **行の入れ替え**(#1213、`Alt+↑` / `Alt+↓`)の規則。
 *
 * ⚠ 守るのは**動く側**(行が入れ替わり、caret が付いていく)と**動かない側**(端では `null`)の
 * 両方。端で動いてしまうと、先頭の行を押すたびに本文が回ってしまう。
 */
import { describe, expect, it } from 'vitest';
import { swapLines, type SwapEdit } from '../../src/features/markdown/line-swap';
import type { TextSelection } from '../../src/features/markdown/text-ops';

/** `|` で選択範囲を書く(1 つなら caret)。 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf('|');
  const second = marked.indexOf('|', start + 1);
  const end = second === -1 ? start : second - 1;
  return { text: marked.replace(/\|/g, ''), start, end };
}
function show(s: TextSelection): string {
  if (s.start === s.end) return `${s.text.slice(0, s.start)}|${s.text.slice(s.start)}`;
  return `${s.text.slice(0, s.start)}|${s.text.slice(s.start, s.end)}|${s.text.slice(s.end)}`;
}
function ok(r: SwapEdit | null): SwapEdit {
  expect(r, '動くはずの場面で null(何も起きない)').not.toBeNull();
  return r!;
}
/** 呼び側が書く形(`from`〜`to` を `insert` へ置き換える)で作った本文が、`text` と一致すること。 */
function applied(before: TextSelection, r: SwapEdit): string {
  return before.text.slice(0, r.from) + r.insert + before.text.slice(r.to);
}

describe('↑ ── 前の行と入れ替わる', () => {
  it('中の行: 直前の行と入れ替わり、caret は行の中身に付いていく', () => {
    expect(show(ok(swapLines(sel('あ\nい|う\nえ'), -1)))).toBe('い|う\nあ\nえ');
  });

  it('末尾の行(末尾改行なし)', () => {
    expect(show(ok(swapLines(sel('a\nb|'), -1)))).toBe('b|\na');
  });

  it('末尾の行(末尾改行あり)── 末尾の改行は保たれる', () => {
    expect(show(ok(swapLines(sel('a\nb|\n'), -1)))).toBe('b|\na\n');
  });

  it('先頭が空行でも、2 行目から上へ動く(行頭を取り違えない)', () => {
    expect(show(ok(swapLines(sel('\nb|'), -1)))).toBe('b|\n');
    expect(show(ok(swapLines(sel('x\n\n|c'), -1)))).toBe('x\n|c\n');
  });

  it('空行とも入れ替わる(行は字ではなく行である)', () => {
    expect(show(ok(swapLines(sel('a\n\nb|'), -1)))).toBe('a\nb|\n');
  });

  it('複数行を選んでいれば、選んだ行の塊ごと上へ(選択は塊に付いていく)', () => {
    expect(show(ok(swapLines(sel('あ\n|い\nう|\nえ'), -1)))).toBe('|い\nう|\nあ\nえ');
  });

  it('選択の終わりが次の行の頭なら、その行は巻き込まない', () => {
    const r = ok(swapLines(sel('あ\n|い\n|う'), -1));
    expect(r.text).toBe('い\nあ\nう');
  });

  it('範囲選択が行の途中から途中でも、その行の全体が動く', () => {
    expect(ok(swapLines(sel('あ\nい|い\nう|う\nえ'), -1)).text).toBe('いい\nうう\nあ\nえ');
  });

  it('🔴 先頭の行では動かない(null)── 折り返して回さない', () => {
    expect(swapLines(sel('あ|\nい'), -1)).toBeNull();
    expect(swapLines(sel('|あ\nい'), -1)).toBeNull();
    expect(swapLines(sel('|あ\nい|\nう'), -1)).toBeNull();
  });
});

describe('↓ ── 次の行と入れ替わる', () => {
  it('中の行: 直後の行と入れ替わり、caret は行の中身に付いていく', () => {
    expect(show(ok(swapLines(sel('あ\nい|う\nえ'), 1)))).toBe('あ\nえ\nい|う');
  });

  it('先頭の行', () => {
    expect(show(ok(swapLines(sel('a|\nb'), 1)))).toBe('b\na|');
  });

  it('次が末尾の行(末尾改行なし)', () => {
    expect(show(ok(swapLines(sel('|a\nb'), 1)))).toBe('b\n|a');
  });

  it('次が末尾の行(末尾改行あり)── 末尾の改行は保たれる', () => {
    expect(show(ok(swapLines(sel('|a\nb\n'), 1)))).toBe('b\n|a\n');
  });

  it('末尾改行のあとの空の行も 1 行(欄に見えている行)', () => {
    expect(show(ok(swapLines(sel('a\n|b\n'), 1)))).toBe('a\n\n|b');
  });

  it('複数行を選んでいれば、選んだ行の塊ごと下へ', () => {
    expect(show(ok(swapLines(sel('あ\n|い\nう|\nえ'), 1)))).toBe('あ\nえ\n|い\nう|');
  });

  it('選択の終わりが次の行の頭なら、その行は巻き込まない(動くのは選んだ行の次の行)', () => {
    const r = ok(swapLines(sel('|あ\n|い\nう'), 1));
    expect(r.text).toBe('い\nあ\nう');
  });

  it('🔴 末尾の行では動かない(null)', () => {
    expect(swapLines(sel('あ\nい|'), 1)).toBeNull();
    expect(swapLines(sel('あ\n|い\nう|'), 1)).toBeNull();
    // 1 行だけの欄 ── 1 行だけの塊の row-source は、ここで必ず null になる
    expect(swapLines(sel('見出し|'), 1)).toBeNull();
    expect(swapLines(sel('見出し|'), -1)).toBeNull();
    expect(swapLines(sel('|'), 1)).toBeNull();
  });
});

describe('置き換えの範囲(呼び側が insertText で書く形)', () => {
  it('🔴 動かした 2 つの行だけを置き換える(他の行は 1 字も触れない ── 取り消しの粒度)', () => {
    const before = sel('A\nB\nC|\nD\nE');
    const r = ok(swapLines(before, -1));
    expect([r.from, r.to, r.insert]).toEqual([2, 5, 'C\nB']);
    expect(applied(before, r)).toBe(r.text);
    const down = ok(swapLines(before, 1));
    expect([down.from, down.to, down.insert]).toEqual([4, 7, 'D\nC']);
    expect(applied(before, down)).toBe(down.text);
  });

  it('どの形でも、置き換えた結果が `text` と一致する(全数)', () => {
    const texts = ['a', 'a\nb', 'a\nb\n', '\na', 'a\n\nb', '\n\n', 'a\nb\nc\nd\n'];
    let moved = 0;
    for (const t of texts) {
      for (let s = 0; s <= t.length; s += 1) {
        for (let e = s; e <= t.length; e += 1) {
          for (const dir of [-1, 1] as const) {
            const before = { text: t, start: s, end: e };
            const r = swapLines(before, dir);
            if (r === null) continue;
            moved += 1;
            expect(applied(before, r), `${JSON.stringify(before)} ${dir}`).toBe(r.text);
            // 行の数は変わらず、行の中身は並べ替わっただけ
            expect(r.text.split('\n').sort(), `${JSON.stringify(before)} ${dir}`).toEqual(
              t.split('\n').sort(),
            );
            expect(r.text.length).toBe(t.length);
            // 選択の長さは変わらない
            expect(r.end - r.start).toBe(e - s);
          }
        }
      }
    }
    // 空振り防止: 全数のうち、実際に動いた形が十分にある
    expect(moved).toBeGreaterThan(100);
  });

  it('🔴 ↑ のあとに ↓ で元に戻る(往復)', () => {
    const before = sel('あ\nい|\nう');
    const up = ok(swapLines(before, -1));
    const back = ok(swapLines(up, 1));
    expect(back.text).toBe(before.text);
    expect([back.start, back.end]).toEqual([before.start, before.end]);
  });

  it('表の `|---|` の行とも字として入れ替わる(止めない)', () => {
    // ⚠ `sel()` は `|` を印に使うので、表の字は直に書く
    const text = '| a | b |\n|---|---|\n| 1 | 2 |';
    const caret = text.indexOf('|---|') + 2;
    const up = ok(swapLines({ text, start: caret, end: caret }, -1));
    expect(up.text).toBe('|---|---|\n| a | b |\n| 1 | 2 |');
    const down = ok(swapLines({ text, start: caret, end: caret }, 1));
    expect(down.text).toBe('| a | b |\n| 1 | 2 |\n|---|---|');
  });
});

describe('🔴 入れ子の項目は子も一緒に動く(#1163 依頼 204)', () => {
  const list = '- 牛乳\n  - 低脂肪\n  - 無脂肪\n- 卵\n- パン\n  - 食パン';

  it('↓ ── 子を持つ項目は、子ごと下の兄弟と入れ替わる', () => {
    const r = ok(swapLines(sel('- |牛乳\n  - 低脂肪\n  - 無脂肪\n- 卵\n- パン\n  - 食パン'), 1));
    expect(r.text).toBe('- 卵\n- 牛乳\n  - 低脂肪\n  - 無脂肪\n- パン\n  - 食パン');
    // caret は動かした項目に付いていく
    expect(r.text.slice(r.start - 2, r.start + 2)).toBe('- 牛乳');
  });

  it('↑ ── 上の兄弟が子を持つとき、その子ごと越える', () => {
    const r = ok(swapLines(sel('- 牛乳\n  - 低脂肪\n  - 無脂肪\n- |卵\n- パン\n  - 食パン'), -1));
    expect(r.text).toBe('- 卵\n- 牛乳\n  - 低脂肪\n  - 無脂肪\n- パン\n  - 食パン');
  });

  it('↑ ── 子を持つ項目を上へ動かすと、上の兄弟を越える(子もついていく)', () => {
    const before = sel('- 卵\n- |パン\n  - 食パン');
    const r = ok(swapLines(before, -1));
    expect(r.text).toBe('- パン\n  - 食パン\n- 卵');
    expect(applied(before, r)).toBe(r.text);
  });

  it('↓ ── 子の項目だけを動かすときは、同じ深さの兄弟と入れ替わる(親を飛び越えない)', () => {
    const r = ok(swapLines(sel('- 牛乳\n  - |低脂肪\n  - 無脂肪\n- 卵'), 1));
    expect(r.text).toBe('- 牛乳\n  - 無脂肪\n  - 低脂肪\n- 卵');
  });

  it('↑ ── 最初の子を上へ動かすと、これまでどおり直前の 1 行(親)と入れ替わる', () => {
    const r = ok(swapLines(sel('- 牛乳\n  - |低脂肪'), -1));
    expect(r.text).toBe('  - 低脂肪\n- 牛乳');
  });

  it('↑ ↓ の往復で元に戻る(子ごと)', () => {
    const before = sel(list.replace('- 卵', '- |卵'));
    const up = ok(swapLines(before, -1));
    const back = ok(swapLines(up, 1));
    expect(back.text).toBe(before.text);
    expect([back.start, back.end]).toEqual([before.start, before.end]);
  });

  it('空行で子は切れる(空行の先は別の塊)・字下げした続きの行は子として一緒に動く', () => {
    const r = ok(swapLines(sel('- |あ\n\n  い\n- う'), 1));
    expect(r.text).toBe('\n- あ\n  い\n- う');
    const r2 = ok(swapLines(sel('- |あ\n  続きの行\n- う'), 1));
    expect(r2.text).toBe('- う\n- あ\n  続きの行');
  });

  it('日本語の項目(全角の記号・字)でも同じ', () => {
    const r = ok(swapLines(sel('- |買い物（週末）\n  - 牛乳　2 本\n- 掃除'), 1));
    expect(r.text).toBe('- 掃除\n- 買い物（週末）\n  - 牛乳　2 本');
  });

  it('項目でない行は、深く字下げした行が続いても 1 行だけ動く(これまでどおり)', () => {
    const r = ok(swapLines(sel('|あ\n  い\nう'), 1));
    expect(r.text).toBe('  い\nあ\nう');
  });
});
