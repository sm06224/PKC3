import { describe, expect, it } from 'vitest';
import { assetChoices, assetInsertEdit, atChoices, detectTrigger, slashChoices, slashToolChoices, SLASH_TOOLS } from '../../src/features/markdown/inline-complete';

const meta = (lid: string, title: string, i: number) =>
  ({ lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i, status: null, date: null, archived: false }) as never;
const metas = new Map<string, never>([
  ['a', meta('a', '先週の議事録', 1)],
  ['b', meta('b', '買い物メモ', 2)],
  ['self', meta('self', '議事録の下書き', 3)],
]);

describe('detectTrigger(#1449 / #1450)', () => {
  it('行頭の / は引き金。途中の / は引き金ではない', () => {
    expect(detectTrigger('/h2', 3)).toEqual({ kind: 'slash', start: 0, query: 'h2' });
    expect(detectTrigger('前の行\n  /table', 13)).toMatchObject({ kind: 'slash', query: 'table' });
    expect(detectTrigger('A/B', 3)).toBeNull();
    expect(detectTrigger('https://x', 9)).toBeNull();
    expect(detectTrigger('2026/10/26', 10)).toBeNull();
    expect(detectTrigger('//', 2)).toBeNull();
  });
  it('日本語入力の ／ は引き金。・ は字が続いたときだけ', () => {
    expect(detectTrigger('／表', 2)).toMatchObject({ kind: 'slash', query: '表' });
    expect(detectTrigger('・', 1)).toBeNull();
    expect(detectTrigger('・りんご', 4)).toMatchObject({ kind: 'slash', query: 'りんご' });
  });
  it('@ は行頭か空白の直後だけ。予定記法 @2026- と @[card] は引き金ではない', () => {
    expect(detectTrigger('@', 1)).toEqual({ kind: 'at', start: 0, query: '' });
    expect(detectTrigger('見て @議事', 6)).toEqual({ kind: 'at', start: 3, query: '議事' });
    expect(detectTrigger('foo@example.com', 15)).toBeNull();
    expect(detectTrigger('- [ ] 提出 @2026-10-26', 22)).toBeNull();
    expect(detectTrigger('@[card](entry:x)', 2)).toBeNull();
  });
});

describe('slashChoices', () => {
  it('/h2 は見出し2、/table は表、/ だけなら上限まで', () => {
    expect(slashChoices([], 'h2').map((c) => c.title)).toContain('見出し2');
    expect(slashChoices([], 'table').map((c) => c.title)).toContain('表');
    expect(slashChoices([], '')).toHaveLength(8);
    expect(slashChoices([], 'zzzz-no-such')).toHaveLength(0);
  });
  it('自分のテンプレートは短縮語でも引け、先頭に出る', () => {
    const items = [{ lid: 't1', title: '議事録の型', abbr: 'gj', body: '# 議事録' }] as never;
    const got = slashChoices(items, 'gj');
    expect(got[0]).toMatchObject({ kind: 'snippet', lid: 't1' });
  });
});

describe('atChoices', () => {
  const now = new Date(2026, 9, 26);
  it('today / 明日 は日付、題名はノート。自分自身は出さない', () => {
    const d = atChoices('today', now, metas, ['a', 'b', 'self'], 'self');
    expect(d[0]).toMatchObject({ kind: 'date', id: 'today', date: '2026-10-26' });
    expect(atChoices('明日', now, metas, ['a'], null)[0]).toMatchObject({ kind: 'date', date: '2026-10-27' });
    const n = atChoices('議事', now, metas, ['a', 'b', 'self'], 'self');
    expect(n.map((c) => (c.kind === 'note' ? c.lid : 'date'))).toEqual(['a']);
  });
});

describe('コードの中・表の行では出ない(着地前レビュー)', () => {
  const at = (v: string) => detectTrigger(v, v.length);
  it('フェンスの中(``` / ~~~)では / も @ も出ない。閉じたあとは出る(対照群)', () => {
    expect(at('```\n/h2')).toBeNull();
    expect(at('```js\ncode\n@議事')).toBeNull();
    expect(at('~~~\n/表')).toBeNull();
    expect(at('```\ncode\n```\n/h2'), '閉じたあとなのに出ない').toMatchObject({ kind: 'slash', query: 'h2' });
    expect(at('```\ncode\n```\n見て @議事'), '閉じたあとなのに出ない').toMatchObject({ kind: 'at' });
  });
  it('行内コードの中では出ない。閉じたあとは出る(対照群)', () => {
    expect(at('`foo @bar')).toBeNull();
    expect(at('`a` と @bar'), '閉じたあとなのに出ない').toMatchObject({ kind: 'at', query: 'bar' });
  });
  it('表の行(| で始まる行)では出ない。ふつうの行は出る(対照群)', () => {
    expect(at('| 項目 | @議事')).toBeNull();
    expect(at('  | a | b | @x')).toBeNull();
    expect(at('項目 @議事')).toMatchObject({ kind: 'at' });
  });
});

describe('slashToolChoices(#1982 段 3)── 先に聞く挿入の道具', () => {
  it('空の / には出さない(今までの 8 件の顔ぶれを道具が奪わない)', () => {
    expect(slashToolChoices('')).toEqual([]);
  });
  it('字(含む)でも綴り(前方一致)でも絞れる', () => {
    expect(slashToolChoices('日付').map((t) => t.action)).toEqual(['insert-date']);
    expect(slashToolChoices('date').map((t) => t.action)).toEqual(['insert-date']);
    expect(slashToolChoices('ATT').map((t) => t.action)).toEqual(['insert-attachment']);
    expect(slashToolChoices('notelink').map((t) => t.action)).toEqual(['insert-entry-link']);
    expect(slashToolChoices('icon').map((t) => t.action)).toEqual(['insert-icon']);
  });
  it('当たらない語・文中の字では出ない / 全道具が空でない字と綴りを持つ', () => {
    expect(slashToolChoices('zzzz-no-such')).toEqual([]);
    expect(slashToolChoices('usr/bin')).toEqual([]);
    expect(SLASH_TOOLS.length).toBeGreaterThanOrEqual(4);
    for (const t of SLASH_TOOLS) {
      expect(t.label, t.action).not.toBe('');
      expect(t.keys.length, t.action).toBeGreaterThan(0);
    }
  });
});

describe('(asset: の補完(#2001 段 4)', () => {
  const rows = [
    { lid: 'a', name: '請求書.pdf', mime: 'application/pdf', size: 2048, key: 'k1' },
    { lid: 'b', name: 'photo one.png', mime: 'image/png', size: 100, key: 'k 2' },
    { lid: 'c', name: 'memo.txt', mime: 'text/plain', size: null, key: 'k3' },
  ];
  it('3 つの書き方どれでも引き金になり、start は `(` の位置', () => {
    expect(detectTrigger('(asset:', 7)).toEqual({ kind: 'asset', start: 0, query: '' });
    expect(detectTrigger('![](asset:ab', 12)).toEqual({ kind: 'asset', start: 3, query: 'ab' });
    expect(detectTrigger('x [名前](asset:', 13)).toEqual({ kind: 'asset', start: 6, query: '' });
  });
  it('コードの中では出ず、表のセルの中では出る / 語に空白が入ったら終わり', () => {
    expect(detectTrigger('`(asset:', 8)).toBeNull();
    expect(detectTrigger('```\n(asset:', 11)).toBeNull();
    expect(detectTrigger('| ![](asset:', 12)?.kind).toBe('asset');
    expect(detectTrigger('(asset:a b', 10)).toBeNull();
  });
  it('語で絞る(名前・種類の名前)。空なら先頭から。添え書きは種類 · 大きさ', () => {
    expect(assetChoices(rows, '').map((c) => c.row.lid)).toEqual(['a', 'b', 'c']);
    expect(assetChoices(rows, '請求').map((c) => c.row.lid)).toEqual(['a']);
    expect(assetChoices(rows, 'pdf').map((c) => c.row.lid)).toEqual(['a']);
    expect(assetChoices(rows, 'PNG').map((c) => c.row.lid)).toEqual(['b']);
    expect(assetChoices(rows, 'zzz')).toEqual([]);
    expect(assetChoices(rows, '')[0]?.sub).toBe('PDF · 2.0 KB');
    expect(assetChoices(rows, '')[2]?.sub).toBe('テキスト');
  });
  it('入れる形: 画像は ! 付き・ラベルは打ったものを使う・自動の ) を二重にしない', () => {
    expect(assetInsertEdit('a (asset:ph)', 2, 11, rows[1]!)).toEqual({ start: 2, end: 12, text: '![photo one.png](<asset:k 2>)' });
    expect(assetInsertEdit('[](asset:', 2, 9, rows[0]!)).toEqual({ start: 0, end: 9, text: '[請求書.pdf](asset:k1)' });
    expect(assetInsertEdit('前 [図1](asset:', 6, 13, rows[1]!)).toEqual({ start: 2, end: 13, text: '![図1](<asset:k 2>)' });
    expect(assetInsertEdit('![](asset:', 3, 10, rows[0]!).text).toBe('[請求書.pdf](asset:k1)');
  });
});

describe('言葉の統一のあとも、旧い言い方(入れる)で / の道具が見つかる', () => {
  it('「入れる」「日付を入れる」で、改名した「日付を挿入」が出る', () => {
    expect(slashToolChoices('入れる').map((t) => t.action)).toEqual(
      expect.arrayContaining(['insert-date', 'insert-entry-link', 'insert-attachment', 'insert-icon']),
    );
    expect(slashToolChoices('日付を入れる').map((t) => t.label)).toEqual(['日付を挿入']);
  });
});
