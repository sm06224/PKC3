/**
 * 🔴 タグの色(#1457)── 純粋部分。
 *
 * 守るもの:①`#rrggbb` 以外は付けない(小文字にそろえる)②付けたら外せる(外すと「色なし」に戻る)
 * ③字の色は全色で 4.5 以上 ④CSS は**色を付けたタグにしか**当たらず、見せ方ごとに当て方が違う
 * ⑤バックアップから読む値も検める。
 * 守っていないもの:実ブラウザでの見え方(`tests/smoke/tag-badge.smoke.spec.ts` が計算後の色で見る)。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TAG_COLORS,
  contrastRatio,
  mergeMissingTagColors,
  normalizeTagColor,
  parseTagColorList,
  tagColorCss,
  tagColorKey,
  tagColorOf,
  tagInkFor,
  withTagColor,
  type TagColorEntry,
} from '../../src/features/tag-color';

const L = (xs: Array<[string, string]>): TagColorEntry[] =>
  xs.map(([tag, color]) => ({ tag, color }));

describe('normalizeTagColor', () => {
  it('#rrggbb だけを受け、小文字にそろえる', () => {
    expect(normalizeTagColor('#FF8800')).toBe('#ff8800');
    expect(normalizeTagColor('#ff8800')).toBe('#ff8800');
  });
  it.each(['#f80', '#ff8800aa', 'ff8800', 'red', 'rgb(1,2,3)', ' #ff8800', '#ff8800 ', '#gg0000', '', '#ff880', '#ff88000'])(
    '%j は受けない',
    (bad) => {
      expect(normalizeTagColor(bad)).toBeNull();
    },
  );
  it('文字列でない値は受けない', () => {
    for (const v of [null, undefined, 0xff8800, {}, ['#ff8800']]) {
      expect(normalizeTagColor(v)).toBeNull();
    }
  });
});

describe('字の色(黒 / 白)', () => {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  it('🔑 4096 色(各チャンネル 16 段)とグレー全 256 段で、選んだ字が 4.5 以上', () => {
    let n = 0;
    let worst = 99;
    for (let r = 0; r < 256; r += 17) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 17) {
          const c = `#${hex(r)}${hex(g)}${hex(b)}`;
          const ratio = contrastRatio(c, tagInkFor(c));
          worst = Math.min(worst, ratio);
          n++;
          expect(ratio, c).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(n).toBe(4096); // 掃引が実際に回ったこと(0 件で緑にならない)
    for (let v = 0; v < 256; v++) {
      const c = `#${hex(v)}${hex(v)}${hex(v)}`;
      const ratio = contrastRatio(c, tagInkFor(c));
      worst = Math.min(worst, ratio);
      expect(ratio, c).toBeGreaterThanOrEqual(4.5);
    }
    // 境目では 4.58 付近まで下がる = 「黒と白の良いほう」を選べている(片方に固定していない)
    expect(worst).toBeLessThan(5);
  });
  it('明るい色には黒、暗い色には白(常に同じ字にしていない)', () => {
    expect(tagInkFor('#ffff00')).toBe('#000000');
    expect(tagInkFor('#ffffff')).toBe('#000000');
    expect(tagInkFor('#000080')).toBe('#ffffff');
    expect(tagInkFor('#000000')).toBe('#ffffff');
  });
});

describe('withTagColor ── 付ける / 変える / 外す', () => {
  it('付けると小文字の #rrggbb で入り、外すと消える(片道にしない)', () => {
    const a = withTagColor([], '買い物', '#FF0000');
    expect(a).toEqual({ ok: true, list: [{ tag: '買い物', color: '#ff0000' }] });
    if (!a.ok) throw new Error('unreachable');
    const b = withTagColor(a.list, '買い物', null);
    expect(b).toEqual({ ok: true, list: [] });
    expect(tagColorOf(b.ok ? b.list : [{ tag: 'x', color: '#000000' }], '買い物')).toBeNull();
  });
  it('🔴 #rrggbb でない色は断る(黙って別の色にしない)', () => {
    expect(withTagColor([], 'a', 'red')).toEqual({ ok: false, reason: 'invalid-color' });
    expect(withTagColor([], 'a', '#fff')).toEqual({ ok: false, reason: 'invalid-color' });
  });
  it('空のタグは断る', () => {
    expect(withTagColor([], '  #  ', '#ff0000')).toEqual({ ok: false, reason: 'invalid-tag' });
  });
  it('大小違いの同じタグは置き換える(2 つ並べない)', () => {
    const a = withTagColor(L([['Work', '#111111']]), 'work', '#222222');
    expect(a).toEqual({ ok: true, list: [{ tag: 'work', color: '#222222' }] });
    expect(tagColorOf(L([['Work', '#111111']]), 'WORK')).toBe('#111111');
  });
  it('外すのは色が無いタグでも成功し、他のタグを動かさない', () => {
    const base = L([['a', '#111111'], ['b', '#222222']]);
    expect(withTagColor(base, 'zzz', null)).toEqual({ ok: true, list: base });
    expect(withTagColor(base, 'a', null)).toEqual({ ok: true, list: [{ tag: 'b', color: '#222222' }] });
  });
  it('上限を超える新しいタグは断る。既に在るタグの色変更は通る', () => {
    const full = Array.from({ length: MAX_TAG_COLORS }, (_, i) => ({ tag: `t${i}`, color: '#123456' }));
    expect(withTagColor(full, 'new', '#ffffff')).toEqual({ ok: false, reason: 'limit' });
    expect(withTagColor(full, 't3', '#ffffff').ok).toBe(true);
  });
  it('井桁つきの綴りは同じタグ(打った字を受け止める)', () => {
    expect(tagColorKey('#買い物')).toBe(tagColorKey('買い物'));
  });
});

describe('parseTagColorList / mergeMissingTagColors', () => {
  it('壊れた要素・読めない色は落として数える', () => {
    const r = parseTagColorList([
      { tag: 'ok', color: '#ABCDEF' },
      { tag: 'bad', color: 'blue' },
      { tag: 5, color: '#000000' },
      null,
    ]);
    expect(r.list).toEqual([{ tag: 'ok', color: '#abcdef' }]);
    expect(r.dropped).toBe(3);
    expect(parseTagColorList('x')).toEqual({ list: [], dropped: 0 });
  });
  it('取り込みは足りない分だけ足し、いまの色は動かさない', () => {
    const m = mergeMissingTagColors(L([['a', '#111111']]), L([['A', '#999999'], ['b', '#222222']]));
    expect(m.list).toEqual([{ tag: 'a', color: '#111111' }, { tag: 'b', color: '#222222' }]);
    expect(m.added).toEqual([{ tag: 'b', color: '#222222' }]);
    expect(m.kept).toBe(1);
    expect(m.overLimit).toBe(0);
  });
  it('🔴 上限を超える分は足さず、数えて返す(黙って捨てない)', () => {
    const full = Array.from({ length: MAX_TAG_COLORS - 1 }, (_, i) => ({ tag: `t${i}`, color: '#123456' }));
    const m = mergeMissingTagColors(full, L([['n1', '#111111'], ['n2', '#222222'], ['n3', '#333333']]));
    expect(m.list).toHaveLength(MAX_TAG_COLORS);
    expect(m.added).toEqual([{ tag: 'n1', color: '#111111' }]);
    expect(m.overLimit).toBe(2);
  });
});

describe('tagColorCss', () => {
  it('色を付けたタグにだけ規則が出る(空の一覧は何も出さない)', () => {
    expect(tagColorCss([])).toBe('');
    const css = tagColorCss(L([['買い物', '#ff8800']]));
    expect(css).toContain('data-pkc-tag-key="買い物"]');
    expect(css).not.toContain('急ぎ');
  });
  it('バッジは下地 + 自動の字、枠だけは枠の線だけ、文字のままには当てない', () => {
    const css = tagColorCss(L([['a', '#ffff00'], ['b', '#000080']]));
    expect(css).toContain('background:#ffff00;color:#000000');
    expect(css).toContain('background:#000080;color:#ffffff');
    const outline = css
      .split('}')
      .filter((r) => r.includes('html[data-pkc-tag-badge="outline"]'))
      .join('}');
    expect(outline).toContain('border:2px solid #ffff00');
    expect(outline).not.toContain('background');
    // 文字のまま(plain)に当てる規則は無い ── バッジの規則は plain を除外している
    expect(css).not.toContain('html[data-pkc-tag-badge="plain"]');
    expect(css).toContain(':not([data-pkc-tag-badge="plain"])');
  });
  it('当て先は札だけ(外すボタンなど data-pkc-tag を持つ他の物には当てない)', () => {
    const css = tagColorCss(L([['a', '#ff0000']]));
    const rules = css.split('}').filter((r) => r.trim() !== '');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const part of rule.split('{')[0]!.split(',')) {
        expect(part, part).toMatch(/\.pkc-tag\[|inspector-tag-find"\]|inspector-body-tag-find"\]/);
      }
    }
  });
  it('タグ名の引用符・逆斜線は CSS の字として閉じる(規則を壊せない)', () => {
    const css = tagColorCss(L([['a"]{x:y}\\', '#ff0000']]));
    expect(css).toContain('data-pkc-tag-key="a\\"]{x:y}\\\\"]');
  });
  it('🔴 制御文字(NUL / U+001F / DEL)は \\XX の形で閉じ、生の制御文字を CSS に書かない', () => {
    const css = tagColorCss(L([['a\u0000b\u001fc\u007fd', '#ff0000']]));
    // eslint-disable-next-line no-control-regex
    expect(css, '生の制御文字が CSS に残っている').not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(css).toContain('data-pkc-tag-key="a\\0 b\\1f c\\7f d"]');
  });
  it('🔴 改行・改頁・タブ入りのタグ名は、正規化されて規則の外へ出ない', () => {
    const css = tagColorCss(L([['x\fy\nz\tw', '#ff0000']]));
    // 規則は 1 行 1 タグ分 ── 改行で文字列が割れていない
    expect(css.split('\n')).toHaveLength(1);
    expect(css).toContain('data-pkc-tag-key="x y z w"]');
  });
  it('🔴 全角 Ａ/ａ・Ä/ä も大小違いの同じタグ(鍵が一致する。CSS の i には頼らない)', () => {
    expect(tagColorKey('Ａbc')).toBe(tagColorKey('ａBC'));
    expect(tagColorKey('Ärger')).toBe(tagColorKey('ärger'));
    const css = tagColorCss(L([['Ärger', '#ff0000'], ['Ａbc', '#00ff00']]));
    expect(css).toContain(`data-pkc-tag-key="${tagColorKey('ärger')}"]`);
    expect(css).toContain(`data-pkc-tag-key="${tagColorKey('ａbc')}"]`);
    expect(css).not.toContain(' i]');
  });
  it('🔴 #rrggbb でない値が来ても CSS に書かない', () => {
    expect(tagColorCss([{ tag: 'a', color: 'red;}body{display:none' }])).toBe('');
  });
});
