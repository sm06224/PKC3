/** @vitest-environment node */
/**
 * 🔴 **本文の中のタグ**(#550 段①)── 純粋層の全数検査。
 *
 * ⚠ この層は**画面にも保存にも繋がっていない**。だからここで規則を固めきる ──
 * 上へ繋いでから記法を変えると、user が書いた本文の見え方が動く。
 *
 * 🔑 いちばん大事なのは「**既存の本文を 1 行も壊さない**」ことなので、
 * **見出しが 1 件も巻き込まれないこと**を総当たりで見る。
 */
import { describe, expect, it } from 'vitest';
import { scanBodyTags } from '@features/flavor/body-tags';

const names = (body: string): string[] => scanBodyTags(body).map((t) => t.name);

describe('タグ行の判定(#550 段①)', () => {
  it('🔴 単独行のタグを拾う', () => {
    expect(names('#買い物 #急ぎ\n')).toEqual(['買い物', '急ぎ']);
  });

  it('🔴 見出しは 1 件も巻き込まない ── 井桁の直後の空白が分かれ目', () => {
    // ⚠ **総当たり**で見る(1 例だけだと「たまたま通った」が残る)
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const h = '#'.repeat(level);
      expect(names(`${h} 見出しの字\n`), `${h} 見出しをタグにした`).toEqual([]);
      expect(names(`${h}\t見出しの字\n`), `${h}+タブ をタグにした`).toEqual([]);
    }
  });

  it('⚠ 区切りは半角空白・全角空白・タブのどれでもよい', () => {
    expect(names('#あ #い\n'), '半角空白で割れない').toEqual(['あ', 'い']);
    expect(names('#あ　#い\n'), '全角空白で割れない').toEqual(['あ', 'い']);
    expect(names('#あ\t#い\n'), 'タブで割れない').toEqual(['あ', 'い']);
    expect(names('　#あ　#い　\n'), '前後の全角空白で落ちた').toEqual(['あ', 'い']);
  });

  it('🔴 数字だけのタグは作らない ── 番号を並べた行を守る', () => {
    // ⚠ この repo の doc に `#117 #121` の形が 12 回出てくる(設計 doc §3.3)
    expect(names('#117 #121\n'), '番号の行をタグにした').toEqual([]);
    // 🔑 対照群 ── 数字以外が 1 文字でもあればタグである
    expect(names('#no117\n'), '数字以外を含むのに落とした').toEqual(['no117']);
    expect(names('#117a\n'), '数字以外を含むのに落とした').toEqual(['117a']);
    // ⚠ 混在した行は、数字だけの側だけが落ちる
    expect(names('#117 #買い物\n'), '混在で本物まで落とした').toEqual(['買い物']);
  });

  it('🔴 fence の中は見ない', () => {
    expect(names('```\n#買い物 #急ぎ\n```\n'), 'コード塊の中を拾った').toEqual([]);
    expect(names('~~~\n#買い物\n~~~\n'), 'チルダの塊の中を拾った').toEqual([]);
    // ⚠ 短い ``` では ```` は閉じない(閉じは同じ文字で同じ数以上)
    expect(names('````\n```\n#中\n````\n#外\n'), '入れ子の閉じを取り違えた').toEqual(['外']);
    // 🔑 対照群 ── 塊の外は拾う
    expect(names('```\ncode\n```\n#買い物\n'), '塊の外を拾えていない').toEqual(['買い物']);
  });

  it('⚠ タグ行でない行は拾わない(混ざった文は素通り)', () => {
    expect(names('これは #買い物 の話です\n'), '文の中の井桁を拾った').toEqual([]);
    expect(names('# \n'), '井桁と空白だけを拾った').toEqual([]);
    expect(names('#\n'), '井桁 1 文字を拾った').toEqual([]);
    expect(names('\n'), '空行を拾った').toEqual([]);
  });

  it('🔴 どの見出しで付いたかを持つ(user 要件の中心)', () => {
    const body = ['# 買い物', '', '## 週末', '', '#急ぎ', '', '# 仕事', '', '#資料'].join('\n');
    const got = scanBodyTags(body);
    expect(got.map((t) => t.name)).toEqual(['急ぎ', '資料']);
    expect(got[0]!.heading, '見出しの道筋が違う').toEqual(['買い物', '週末']);
    // ⚠ **浅い見出しへ戻ったら、深い側は道筋から外れる**
    expect(got[1]!.heading, '前の深い見出しが残っている').toEqual(['仕事']);
  });

  it('⚠ 見出しの外に書いたタグは道筋が空', () => {
    const got = scanBodyTags('#買い物\n\n# あとから見出し\n');
    expect(got[0]!.heading).toEqual([]);
  });

  it('⚠ 重複は畳まない ── どこで付いたかを捨てないため', () => {
    const got = scanBodyTags(['# あ', '#買い物', '# い', '#買い物'].join('\n'));
    expect(got.map((t) => t.name), '重複を畳んでしまった').toEqual(['買い物', '買い物']);
    expect(got.map((t) => t.line), '行が取れていない').toEqual([1, 3]);
    expect(got.map((t) => t.heading), '見出しが取れていない').toEqual([['あ'], ['い']]);
  });
});
